// src/db.js — PostgreSQL client replacing Firestore
// Uses the `pg` package with the Neon connection string from DATABASE_URL
import pg from 'pg';
const { Pool } = pg;

let pool;
let schemaReady;

function getConnectionString() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL must be defined');
  }

  try {
    const url = new URL(connectionString);
    if (url.searchParams.get('sslmode') === 'require' && !url.searchParams.has('uselibpqcompat')) {
      url.searchParams.set('uselibpqcompat', 'true');
      return url.toString();
    }
  } catch {
    return connectionString;
  }

  return connectionString;
}

function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: getConnectionString(),
      ssl: { rejectUnauthorized: false },
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });

    pool.on('error', (err) => {
      console.error('Unexpected pg pool error:', err);
    });
  }
  return pool;
}

// ── Generic query helper ──────────────────────────────────────────────────────
export async function query(sql, params = []) {
  const client = await getPool().connect();
  try {
    const result = await client.query(sql, params);
    return result;
  } finally {
    client.release();
  }
}

async function ensureSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      await query(`
        CREATE EXTENSION IF NOT EXISTS pgcrypto;

        CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY,
          email TEXT UNIQUE NOT NULL,
          password TEXT NOT NULL,
          created_at TIMESTAMPTZ DEFAULT now()
        );

        CREATE TABLE IF NOT EXISTS sessions (
          token TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          expires_at TIMESTAMPTZ NOT NULL,
          created_at TIMESTAMPTZ DEFAULT now()
        );

        CREATE TABLE IF NOT EXISTS vaults (
          user_id TEXT PRIMARY KEY,
          data JSONB NOT NULL,
          updated_at TIMESTAMPTZ DEFAULT now()
        );

        CREATE TABLE IF NOT EXISTS sync_jobs (
          id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
          user_id TEXT,
          status TEXT,
          folder_url TEXT,
          progress JSONB,
          started_at TIMESTAMPTZ DEFAULT now(),
          finished_at TIMESTAMPTZ,
          error TEXT
        );

        CREATE TABLE IF NOT EXISTS ingestion_failures (
          id SERIAL PRIMARY KEY,
          job_id TEXT,
          files JSONB,
          error TEXT,
          status TEXT,
          timestamp TIMESTAMPTZ DEFAULT now()
        );

        CREATE TABLE IF NOT EXISTS archived_documents (
          id SERIAL PRIMARY KEY,
          user_id TEXT,
          document_type TEXT,
          parsed_data JSONB,
          drive_file_ids JSONB,
          drive_file_names JSONB,
          status TEXT,
          determined_date TEXT,
          date_source TEXT,
          created_at TIMESTAMPTZ DEFAULT now()
        );
      `);
    })();
  }
  return schemaReady;
}

// ── Auth helpers ───────────────────────────────────────────────────────────
export async function getUserByEmail(email) {
  await ensureSchema();
  const res = await query('SELECT * FROM users WHERE email = $1', [email]);
  return res.rows[0] ?? null;
}

export async function createUser({ id, email, password }) {
  await ensureSchema();
  await query(
    'INSERT INTO users (id, email, password) VALUES ($1, $2, $3) ON CONFLICT (email) DO NOTHING',
    [id, email, password]
  );
}

export async function getUserById(id) {
  await ensureSchema();
  const res = await query('SELECT * FROM users WHERE id = $1', [id]);
  return res.rows[0] ?? null;
}

// Session helpers
export async function createSession({ token, userId, expiresAt }) {
  await ensureSchema();
  await query(
    `INSERT INTO sessions (token, user_id, expires_at, created_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (token)
     DO UPDATE SET user_id = $2, expires_at = $3`,
    [token, userId, expiresAt]
  );
}

export async function getSession(token) {
  await ensureSchema();
  const res = await query(
    `SELECT s.token, s.user_id, s.expires_at, u.email
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token = $1 AND s.expires_at > now()`,
    [token]
  );
  return res.rows[0] ?? null;
}

// ── Vault helpers ─────────────────────────────────────────────────────────────
export async function getVault(userId) {
  const res = await query('SELECT data FROM vaults WHERE user_id = $1', [userId]);
  return res.rows[0]?.data ?? null;
}

export async function setVault(userId, data) {
  await query(
    `INSERT INTO vaults (user_id, data, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (user_id)
     DO UPDATE SET data = $2, updated_at = now()`,
    [userId, JSON.stringify(data)]
  );
}

// ── Sync job helpers ──────────────────────────────────────────────────────────
export async function createSyncJob({ userId, folderUrl, treeId }) {
  const res = await query(
    `INSERT INTO sync_jobs (user_id, status, folder_url, progress, started_at)
     VALUES ($1, 'running', $2, $3, now())
     RETURNING id`,
    [userId, folderUrl, JSON.stringify({ total: 0, processed: 0, failed: 0, treeId: treeId || null })]
  );
  return res.rows[0].id;
}

export async function updateSyncJob(jobId, fields) {
  // fields is a plain object — build SET clause dynamically
  const keys = Object.keys(fields);
  const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
  const vals = keys.map(k => {
    const v = fields[k];
    return typeof v === 'object' ? JSON.stringify(v) : v;
  });
  await query(`UPDATE sync_jobs SET ${sets} WHERE id = $1`, [jobId, ...vals]);
}

export async function getSyncJob(jobId) {
  const res = await query('SELECT * FROM sync_jobs WHERE id = $1', [jobId]);
  return res.rows[0] ?? null;
}

// ── Ingestion failure helpers ──────────────────────────────────────────────────
export async function addIngestionFailure({ jobId, files, error, status }) {
  await query(
    `INSERT INTO ingestion_failures (job_id, files, error, status, timestamp)
     VALUES ($1, $2, $3, $4, now())`,
    [jobId, JSON.stringify(files), error, status]
  );
}

// ── Archived document helpers ─────────────────────────────────────────────────
export async function addArchivedDocument({ userId, documentType, parsedData, driveFileIds, driveFileNames, status, determinedDate, dateSource }) {
  await query(
    `INSERT INTO archived_documents
       (user_id, document_type, parsed_data, drive_file_ids, drive_file_names, status, determined_date, date_source, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())`,
    [
      userId,
      documentType,
      JSON.stringify(parsedData),
      JSON.stringify(driveFileIds),
      JSON.stringify(driveFileNames),
      status,
      determinedDate,
      dateSource,
    ]
  );
}
