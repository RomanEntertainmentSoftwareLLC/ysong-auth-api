import pkg from "pg";
const { Pool } = pkg;

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL not set");

export const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false }, // Neon requires SSL
  max: 5,
  idleTimeoutMillis: 30_000
});