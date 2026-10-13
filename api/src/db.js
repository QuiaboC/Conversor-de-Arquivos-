const { Pool } = require("pg");

const pool = new Pool({
    host: process.env.DB_HOST || "localhost",
    port: Number(process.env.DB_PORT || 5432),
    user: process.env.DB_USER || "conversor",
    password: process.env.DB_PASSWORD || "conversor123",
    database: process.env.DB_NAME || "conversor"
});

pool.on("error", (err) => {
    console.error("Erro inesperado no pool do PostgreSQL:", err.message);
});

module.exports = pool;