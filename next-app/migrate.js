// migrate.js — Run this ONCE to create all required tables in Neon PostgreSQL
// Usage: node migrate.js

import 'dotenv/config';
import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const migrations = `
  CREATE TABLE IF NOT EXISTS users (
    id         TEXT PRIMARY KEY,
    email      TEXT UNIQUE NOT NULL,
    password   TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS vaults (
    user_id    TEXT PRIMARY KEY,
    data       JSONB NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS sync_jobs (
    id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    user_id     TEXT,
    status      TEXT,
    folder_url  TEXT,
    progress    JSONB,
    started_at  TIMESTAMPTZ DEFAULT now(),
    finished_at TIMESTAMPTZ,
    error       TEXT
  );

  CREATE TABLE IF NOT EXISTS ingestion_failures (
    id        SERIAL PRIMARY KEY,
    job_id    TEXT,
    files     JSONB,
    error     TEXT,
    status    TEXT,
    timestamp TIMESTAMPTZ DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS archived_documents (
    id               SERIAL PRIMARY KEY,
    user_id          TEXT,
    document_type    TEXT,
    parsed_data      JSONB,
    drive_file_ids   JSONB,
    drive_file_names JSONB,
    status           TEXT,
    determined_date  TEXT,
    date_source      TEXT,
    created_at       TIMESTAMPTZ DEFAULT now()
  );
`;

(async () => {
  const client = await pool.connect();
  try {
    console.log('Running migrations...');
    await client.query(migrations);
    console.log('✅ All tables created successfully!');
  } catch (e) {
    console.error('❌ Migration failed:', e.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
})();
