require("dotenv").config();
const mysql = require("mysql2");

const db = mysql.createConnection({
    host: process.env.DB_HOST || "localhost",
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "",
    database: process.env.DB_NAME || "curebot"
});

db.connect((err) => {
    if (err) {
        console.error("DB Error:", err.message);
        return;
    }
    console.log("MySQL Connected");
});

module.exports = db.promise();