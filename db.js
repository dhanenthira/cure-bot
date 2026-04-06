require("dotenv").config();
const fs = require("fs");
const mysql = require("mysql2");

function parseSslConfig() {
    const sslMode = (process.env.DB_SSL_MODE || process.env.DB_SSL || "").toLowerCase();
    const caPath = process.env.DB_SSL_CA;

    if (!sslMode || sslMode === "false" || sslMode === "off" || sslMode === "disabled") {
        return undefined;
    }

    if (caPath) {
        return {
            ca: fs.readFileSync(caPath, "utf8"),
            rejectUnauthorized: sslMode !== "insecure"
        };
    }

    if (sslMode === "required" || sslMode === "true" || sslMode === "preferred") {
        return {};
    }

    if (sslMode === "insecure") {
        return { rejectUnauthorized: false };
    }

    return undefined;
}

const poolConfig = {
    host: process.env.DB_HOST || "localhost",
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "",
    database: process.env.DB_NAME || "curebot",
    waitForConnections: true,
    connectionLimit: Number(process.env.DB_CONNECTION_LIMIT || 10),
    queueLimit: 0,
    enableKeepAlive: true
};

const ssl = parseSslConfig();
if (ssl) {
    poolConfig.ssl = ssl;
}

const pool = mysql.createPool(poolConfig);
const promisePool = pool.promise();

let lastConnectionError = null;

const connectionErrorCodes = new Set([
    "ECONNREFUSED",
    "ECONNRESET",
    "ENOTFOUND",
    "EHOSTUNREACH",
    "ETIMEDOUT",
    "EAI_AGAIN",
    "PROTOCOL_CONNECTION_LOST",
    "PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR",
    "PROTOCOL_PACKETS_OUT_OF_ORDER",
    "ER_ACCESS_DENIED_ERROR",
    "ER_CON_COUNT_ERROR",
    "HANDSHAKE_SSL_ERROR"
]);

function isConnectionError(err) {
    return Boolean(err && connectionErrorCodes.has(err.code));
}

async function runQuery(method, args) {
    try {
        const result = await promisePool[method](...args);
        lastConnectionError = null;
        return result;
    } catch (err) {
        if (isConnectionError(err)) {
            lastConnectionError = err;
        }
        throw err;
    }
}

async function ping() {
    try {
        await promisePool.query("SELECT 1");
        if (lastConnectionError) {
            console.log("MySQL Connected");
        }
        lastConnectionError = null;
        return true;
    } catch (err) {
        lastConnectionError = err;
        console.error("DB Error:", err.code || err.message || err);
        return false;
    }
}

ping();

module.exports = {
    query: (...args) => runQuery("query", args),
    execute: (...args) => runQuery("execute", args),
    getLastConnectionError: () => lastConnectionError,
    isConfiguredForHostedDb: () => Boolean(process.env.DB_HOST && process.env.DB_HOST !== "localhost"),
    isConnectionError
};
