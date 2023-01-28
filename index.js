require('dotenv').config();
const express = require('express');
const mysql = require('mysql2');
const bodyParser = require('body-parser');
const crypto = require('crypto-js');
const { exec } = require('node:child_process');

console.log('Starting...');
const port = process.env.PORT ?? 8080;

//# Admin Connection:
const adminDatabase = mysql.createPool({
    user: process.env.ADMIN_DB_USERNAME,
    password: process.env.ADMIN_DB_PASSWORD,
    host: process.env.ADMIN_DB_HOST,
    database: process.env.ADMIN_DB_NAME,
    connectionLimit: 5,
    multipleStatements: true
});

//# App:
const api = {};
const app = express();
app.disable('x-powered-by');
app.disable('etag');
app.use(bodyParser.json());

//# Database API:
api.sql = {
    user: {},
    tokens: {}
}

app.post('/sql', authCheck, async (req,res) => {
    let responseData = {};
    const {username,accept,'full-response':fullResponse} = req.headers;
    let result, status;
    let options = Object.assign({sql: null, timeout: 12000},req.body);
    const connection = api.sql.user[username];

    if (!options.sql) {
        res.status(400).type('text/plain').send('[INVALID BODY]\nMissing query in the body!');
        console.log(`400 - Invalid Input (${username}) @ ${req.route.path}`);
        return;
    }
    if (typeof options.timeout !== 'number' || options.timeout < 0) {
        res.status(400).type('text/plain').send('[INVALID BODY]\nSpecified timeout must be a number higher than 0!');
        console.log(`400 - Invalid Input (${username}) @ ${req.route.path}`);
        return;
    }

    res.setTimeout(options.timeout,() => {
        res.status(408).type('text/plain').send('[TIMEOUT]\nDatabase timeout!');
        console.log(`408 - Connection Timeout (${username}) @ ${req.route.path}`);
    });

    try {
        result = await queryResult(options,connection);
        status = 'OK';
        shortResult = 1;
    } catch (error) {
        if (error.sqlMessage == null) {
            if (res.headersSent) return
            res.status(500).type('text/plain').send(`Internal Server Error -\n${error}`);
            console.log(`500 - Internal Server Error (${username}) @ ${req.route.path}`);
            console.error(error);
            return;
        }
        result = `[${error.code}] - ${error.sqlMessage}`;
        shortResult = error.errno;
        status = 'FAIL';
    }
    if (res.headersSent) return

    if (fullResponse?.toLowerCase() === 'false') {
        responseData = {result: shortResult};
    } else {
        responseData = {result, status};
    }
    
    if (accept === 'text/plain') {
        res.type('text/plain').send(JSON.stringify(responseData));
    } else {
        res.type('json').send(responseData);
    }
    console.log(`200 - QUERY [${status}] (${username}) @ ${req.route.path}`);
});

app.post('/sql/connect', authCheck, async (req,res) => {
    let responseData = {};
    const {username,accept,password} = req.headers;

    if (!req.body.user || !req.body.password || !req.body.host) {
        res.status(400).type('text/plain').send('[INVALID BODY]\nMissing required fields in the body!')
        console.log(`400 - Invalid Input (${username}) @ ${req.route.path}`);
        return;
    }

    try {
        const token = crypto.SHA256(`${username}sql${new Date().valueOf()}sql${password}`).toString();
        api.sql.tokens[username] = token;
        api.sql.user[username] = mysql.createPool(req.body);
    
        responseData = {
            token: token,
            status: 'OK'
        }
        if (accept === 'text/plain') {
            res.type('text/plain').send(JSON.stringify(responseData));
        } else {
            res.type('json').send(responseData);
        }
        console.log(`200 - Connect [SUCCESS] (${username}) @ ${req.route.path}`);
    } catch (error) {
        delete api.sql.tokens[username];
        delete api.sql.user[username];

        res.status(500).type('text/plain').send(`Internal Server Error -\n${error}`);
        console.log(`500 - Internal Server Error (${username}) @ ${req.route.path}`);
        console.error(error);
    }
});

app.post('/sql/disconnect', authCheck, async (req,res) => {
    let responseData = {};
    const {username,accept} = req.headers;
    const connection = api.sql.user[username];

    try {
        await endConnection(connection);
        delete api.sql.tokens[username];
        delete api.sql.user[username];

        responseData = {status:'SUCCESS'};
        if (accept === 'text/plain') {
            res.type('text/plain').send(JSON.stringify(responseData));
        } else {
            res.type('json').send(responseData);
        }
        console.log(`200 - Disconnect [SUCCESS] (${username}) @ ${req.route.path}`);
    } catch (error) {
        res.status(500).type('text/plain').send(`Internal Server Error -\n${error}`);
        console.log(`500 - Internal Server Error (${username}) @ ${req.route.path}`);
        console.error(error);
    }
});


//# Logging API:
api.log = {
    tokens: {}
}

app.post('/log', authCheck, async (req,res) => {
    const { username,blank } = req.headers;
    if (blank === 'true') console.log(`${req.body.message}`);
    else console.log(`LOG [${username}] -\n${req.body.message}`)
    res.type('text/plain').send('[SUCCESS]\nLogged to the console!');
});

app.post('/log/connect', authCheck, async (req,res) => {
    let responseData = {};
    const {username,accept,password} = req.headers;

    try {
        const token = crypto.SHA256(`${username}log${new Date().valueOf()}log${password}`).toString();
        api.log.tokens[username] = token;
    
        responseData = {
            token: token,
            status: 'OK'
        }
        if (accept === 'text/plain') {
            res.type('text/plain').send(JSON.stringify(responseData));
        } else {
            res.type('json').send(responseData);
        }
        console.log(`200 - Connect [SUCCESS] (${username}) @ ${req.route.path}`);
    } catch (error) {
        delete api.log.tokens[username];
        res.status(500).type('text/plain').send(`Internal Server Error -\n${error}`);
        console.log(`500 - Internal Server Error (${username}) @ ${req.route.path}`);
        console.error(error);
    }
});

app.post('/log/disconnect', authCheck, async (req,res) => {
    let responseData = {};
    const {username,accept} = req.headers;

    try {
        delete api.log.tokens[username];
        responseData = {status:'SUCCESS'};
        if (accept === 'text/plain') {
            res.type('text/plain').send(JSON.stringify(responseData));
        } else {
            res.type('json').send(responseData);
        }
        console.log(`200 - Disconnect [SUCCESS] (${username}) @ ${req.route.path}`);
    } catch (error) {
        res.status(500).type('text/plain').send(`Internal Server Error -\n${error}`);
        console.log(`500 - Internal Server Error (${username}) @ ${req.route.path}`);
        console.error(error);
    }
});

//# App:
app.head(/.*$/,(req,res) => {
    res.status(200).send(null);
    console.log('200 - OK [Pong!]');
});

app.listen(port, (error) => {
    if (error) throw error;
    console.info(`App listening on port ${port}!`);
    commandListener();
});

//# Functions:
async function authCheck(req,res,next) {
    const { token, username, password } = req.headers;
    const apiId = req.route.path.split('/')[1];
    const apiRoute = req.route.path.split('/')[2];
    let savedToken, savedPassword;

    try {
        if (apiRoute === 'disconnect') {
            if (!api[apiId].tokens[username]) {
                res.status(400).type('text/plain').send('[NO CONNECTION]\nNo connection opened for this user!');
                console.log(`400 - No Connection (${username}) @ ${req.route.path}`);
                return;
            }
        }
        if (apiRoute === 'connect' || apiRoute === 'disconnect') {
            savedPassword = await queryResult({sql:`SELECT * FROM logins WHERE username = ?`,values:[username]},adminDatabase);
            if (apiRoute === 'connect' && api[apiId].tokens[username]) {
                res.status(400).type('text/plain').send('[CONNECTION EXISTS]\nConnection already exists for this user. Close the current connection first!')
                console.log(`400 - Connection Already Exists (${username}) @ ${req.route.path}`);
            } else if (!savedPassword.length) {
                res.status(401).type('text/plain').send('[ACCESS DENIED]\nAccess denied, unknown user!');
                console.log(`401 - Access Denied (${username}) @ ${req.route.path}`);
            } else if (!password || !(crypto.SHA512(password).toString() === savedPassword[0].password_hash)) {
                res.status(403).type('text/plain').send('[ACCESS DENIED]\nAccess denied, wrong password!');
                console.log(`403 - Access Denied (${username}) @ ${req.route.path}`);
            } else {
                next();
            }
        }
        if (apiRoute === undefined) {
            savedToken = api[apiId].tokens[username];
            if (savedToken == null) {
                res.status(400).type('text/plain').type('text/plain').send('[NO CONNECTION]\nNo connection opened for this user!');
                console.log(`400 - No Connection (${username}) @ ${req.route.path}`);
            } else if (savedToken !== token) {
                res.status(403).type('text/plain').type('text/plain').send('[ACCESS DENIED]\nAccess denied, wrong token!');
                console.log(`403 - Access Denied (${username}) @ ${req.route.path}`);
            } else {
                next();
            }
        }
    } catch (error) {
        res.status(500).type('text/plain').send(`Internal Authentication Server Error -\n${error}`);
        console.log(`500 - Internal Authentication Server Error (${username}) @ ${req.route.path}`);
        console.error(error);
    }
}

//*Unused for now
function sendResponse(response,code,data,acceptType = '*/*',dataType = 'text/html') {
    if (acceptType === 'text/plain') {
        if (typeof data === 'object') {
            response.status(code).type('text/plain').send(JSON.stringify(data));
        } else {
            response.status(code).type('text/plain').send(`${data}`);
        }
    } else {
        response.status(code).type(dataType).send(data);
    }
}

async function queryResult(query, connection) {
    return new Promise((resolve, reject) => {
        connection.query(query, (error,result) => {
            if (error) reject(error);
            resolve(result);
        });
    });
}

async function endConnection(connection) {
    return new Promise((resolve, reject) => {
        connection.end((error) => {
            if (error) reject(error);
            resolve(null);
        });
    });
}

async function commandListener() {
    const stdOutput = await new Promise(async (resolve) => {
        const options = {};
    	let input = await new Promise((inputResolve => {
            process.stdin.once('data', data => inputResolve(data.toString().trim()));
        }));
    	let output = 'null\n';
    
    	if (input.startsWith('dir:"')) {
        	let index;
        	options.cwd = '';
        	for (index = 5;input[index] !== '\"';index++) {
            	options.cwd += input[index];
        	}
        	input = input.slice(index+2);
    	}

        if (input.startsWith('sql-user:"')) {
            try {
                let index;
        	    let username = '';
        	    for (index = 10;input[index] !== '\"';index++) {
                	username += input[index];
        	    }
                const userConnection = api.sql.user[username];
                if (userConnection) {
                    output = JSON.stringify(await queryResult(input.slice(index+2),userConnection),null,1);
                } else {
                    output = `User '${username}' not found!`;
                };
            } catch (error) {
                output = error;
            }
        	resolve(`${output}\n`);
    	}

    	if (input.startsWith('sql-admin:')) {
            try {
                output = JSON.stringify(await queryResult(input.slice(10),adminDatabase),null,1);
            } catch (error) {
                output = error;
            }
        	resolve(`${output}\n`);
    	}

        if (input.startsWith('debug:')) {
            try {
                output = `Success!\n${eval(input.slice(6))}`;
            } catch (error) {
                output = `Error!\n${error}`;
            }
        	resolve(`${output}\n`);
    	}
        
    	if (input === 'exit' || input === 'stop') {
        	process.exit(1);
    	}
        
    	if (input === 'clear') {
            output = '\x1Bc\n';
        	resolve(output);
    	}
    
        exec(input, options, (error, stdout, stderr) => {
           	if (stdout) {
            	output = stdout;
            } else if (stderr) {
            	output = stderr;
            } else if (error) {
            	output = `[${error.code} ${error.name}] - ${error.message}`;
            }
            resolve(output);
        });
    });

    process.stdout.write(`> ${stdOutput}`);
    setTimeout(commandListener,250);
}