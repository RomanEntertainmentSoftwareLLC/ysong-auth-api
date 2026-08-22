import pkg from "pg";
const { Pool } = pkg;

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL not set");

const useSsl = process.env.PGSSL === "1" || process.env.PGSSL === "true";

export const pool = new Pool({
	connectionString,
	ssl: useSsl ? { rejectUnauthorized: false } : false,
	max: 5,
	idleTimeoutMillis: 30_000,
});
