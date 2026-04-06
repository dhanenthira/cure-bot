require("dotenv").config();
const fs = require("fs");
const mysql = require("mysql2");

function parseDatabaseUrl() {
    const rawUrl = process.env.DATABASE_URL || process.env.MYSQL_URL || process.env.CLEARDB_DATABASE_URL;
    if (!rawUrl) return null;

    try {
        const parsed = new URL(rawUrl);
        return {
            host: parsed.hostname,
            port: parsed.port ? Number(parsed.port) : 3306,
            user: decodeURIComponent(parsed.username),
            password: decodeURIComponent(parsed.password),
            database: parsed.pathname.replace(/^\//, "")
        };
    } catch (err) {
        console.error("DB URL parse error:", err.message);
        return null;
    }
}

function parseHostAndPort(value) {
    if (!value) {
        return { host: "localhost", port: 3306 };
    }

    const trimmed = value.trim();
    const parts = trimmed.split(":");

    if (parts.length === 2 && /^\d+$/.test(parts[1])) {
        return { host: parts[0], port: Number(parts[1]) };
    }

    return {
        host: trimmed,
        port: Number(process.env.DB_PORT || 3306)
    };
}

function parseSslConfig() {
    const sslMode = (process.env.DB_SSL_MODE || process.env.DB_SSL || process.env.Db_SSL || "").toLowerCase();
    const caPath = process.env.DB_SSL_CA;

    if (!sslMode && process.env.DB_HOST && process.env.DB_HOST !== "localhost") {
        return { rejectUnauthorized: false };
    }

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

const databaseUrlConfig = parseDatabaseUrl();
const hostAndPort = parseHostAndPort(process.env.DB_HOST);

const poolConfig = {
    host: databaseUrlConfig?.host || hostAndPort.host,
    port: databaseUrlConfig?.port || hostAndPort.port,
    user: databaseUrlConfig?.user || process.env.DB_USER || "root",
    password: databaseUrlConfig?.password || process.env.DB_PASSWORD || "",
    database: databaseUrlConfig?.database || process.env.DB_NAME || "curebot",
    waitForConnections: true,
    connectionLimit: Number(process.env.DB_CONNECTION_LIMIT || 10),
    queueLimit: 0,
    enableKeepAlive: true,
    connectTimeout: 15000 // 15s timeout for cloud databases
};

const ssl = parseSslConfig();
if (ssl) {
    poolConfig.ssl = ssl;
}

const pool = mysql.createPool(poolConfig);
const promisePool = pool.promise();

let lastConnectionError = null;
let lastInitError = null;
let initPromise = null;

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
    "HANDSHAKE_SSL_ERROR",
    "ER_BAD_DB_ERROR",
    "ER_DBACCESS_DENIED_ERROR",
    "ER_HOST_NOT_PRIVILEGED",
    "ER_ACCESS_DENIED_NO_PASSWORD_ERROR"
]);

function isConnectionError(err) {
    return Boolean(err && connectionErrorCodes.has(err.code));
}

async function runQuery(method, args) {
    await init();

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

async function ensureSchema() {
    await promisePool.query(`
        CREATE TABLE IF NOT EXISTS users (
            id INT UNSIGNED NOT NULL AUTO_INCREMENT,
            name VARCHAR(100) NOT NULL,
            email VARCHAR(255) NOT NULL,
            password VARCHAR(255) NOT NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (id),
            UNIQUE KEY uq_users_email (email)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await promisePool.query(`
        CREATE TABLE IF NOT EXISTS chat_logs (
            id INT UNSIGNED NOT NULL AUTO_INCREMENT,
            user_id INT UNSIGNED NOT NULL,
            role ENUM('user','bot') NOT NULL,
            message TEXT NOT NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (id),
            CONSTRAINT fk_chatlogs_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
}

async function ping() {
    try {
        await promisePool.query("SELECT 1");
        await ensureSchema();
        if (lastConnectionError) {
            console.log("MySQL Connected");
        }
        lastConnectionError = null;
        lastInitError = null;
        return true;
    } catch (err) {
        lastConnectionError = err;
        lastInitError = err;
        console.error("DB Error:", err.code || err.message || err);
        return false;
    }
}

function init() {
    if (!initPromise) {
        initPromise = ping();
    }
    return initPromise;
}

init();

module.exports = {
    query: (...args) => runQuery("query", args),
    execute: (...args) => runQuery("execute", args),
    getLastConnectionError: () => lastConnectionError,
    getLastInitError: () => lastInitError,
    isConfiguredForHostedDb: () => Boolean(process.env.DB_HOST && process.env.DB_HOST !== "localhost"),
    isConnectionError,
    init
};
