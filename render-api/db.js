// Database access for the Design Studio API. Everything lives in the dtf schema;
// api_apps / api_request_log are created by api/db.php (the studio owns app
// management), the rest is owned here. All DDL is additive and idempotent.
import crypto from 'node:crypto';
import pg from 'pg';

// search_path is part of the connection startup, so no query can ever run before it.
export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 6, options: '-c search_path=dtf,public' });

export const q = (text, params) => pool.query(text, params);
export const one = async (text, params) => (await pool.query(text, params)).rows[0] || null;

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** ART_…, MJ_…, GJ_… — prefix plus 12 random Crockford-base32 characters. */
export function newId(prefix) {
  const bytes = crypto.randomBytes(12);
  let s = '';
  for (const b of bytes) s += ALPHABET[b % 32];
  return `${prefix}_${s}`;
}

export async function ensureSchema() {
  await q(`CREATE TABLE IF NOT EXISTS api_artworks (
    id TEXT PRIMARY KEY,
    app_id BIGINT NULL REFERENCES api_apps(id) ON DELETE SET NULL,
    user_id BIGINT NULL REFERENCES users(id) ON DELETE SET NULL,
    name VARCHAR(200) NOT NULL DEFAULT '',
    file_id TEXT NOT NULL,
    format VARCHAR(10) NOT NULL,
    bytes BIGINT NOT NULL,
    sha256 CHAR(64) NOT NULL,
    width_px INTEGER NOT NULL,
    height_px INTEGER NOT NULL,
    analysis JSONB NOT NULL,
    parent_artwork_id TEXT NULL REFERENCES api_artworks(id) ON DELETE SET NULL,
    prep JSONB NULL,
    review_status VARCHAR(20) NOT NULL DEFAULT 'not_required',
    order_id VARCHAR(100), customer_id VARCHAR(100), lead_id VARCHAR(100),
    requested_by VARCHAR(120), via VARCHAR(10) NOT NULL DEFAULT 'api',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await q(`CREATE INDEX IF NOT EXISTS ix_api_artworks_owner_sha ON api_artworks (COALESCE(app_id, 0), sha256)`);

  await q(`CREATE TABLE IF NOT EXISTS api_jobs (
    id TEXT PRIMARY KEY,
    type VARCHAR(20) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'queued',
    app_id BIGINT NULL REFERENCES api_apps(id) ON DELETE SET NULL,
    user_id BIGINT NULL REFERENCES users(id) ON DELETE SET NULL,
    via VARCHAR(10) NOT NULL DEFAULT 'api',
    requested_by VARCHAR(120),
    order_id VARCHAR(100), customer_id VARCHAR(100), lead_id VARCHAR(100),
    parent_job_id TEXT NULL REFERENCES api_jobs(id) ON DELETE SET NULL,
    input JSONB NOT NULL,
    input_hash CHAR(64) NOT NULL,
    result JSONB NULL,
    warnings JSONB NOT NULL DEFAULT '[]'::jsonb,
    error TEXT NULL,
    engine_version VARCHAR(40) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at TIMESTAMPTZ NULL,
    finished_at TIMESTAMPTZ NULL
  )`);
  await q(`CREATE INDEX IF NOT EXISTS ix_api_jobs_owner_hash ON api_jobs (COALESCE(app_id, 0), input_hash)`);
  await q(`CREATE INDEX IF NOT EXISTS ix_api_jobs_order ON api_jobs (order_id)`);
  await q(`CREATE INDEX IF NOT EXISTS ix_api_jobs_status ON api_jobs (status)`);
  await q(`CREATE INDEX IF NOT EXISTS ix_api_jobs_parent ON api_jobs (parent_job_id)`);

  await q(`CREATE TABLE IF NOT EXISTS api_files (
    id TEXT PRIMARY KEY,
    owner_type VARCHAR(10) NOT NULL,
    owner_id TEXT NOT NULL,
    kind VARCHAR(30) NOT NULL,
    path TEXT NOT NULL,
    file_name VARCHAR(200) NOT NULL,
    content_type VARCHAR(60) NOT NULL,
    bytes BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await q(`CREATE INDEX IF NOT EXISTS ix_api_files_owner ON api_files (owner_type, owner_id)`);

  await q(`CREATE TABLE IF NOT EXISTS api_approvals (
    id TEXT PRIMARY KEY,
    subject_type VARCHAR(20) NOT NULL,
    subject_id TEXT NOT NULL,
    stage VARCHAR(20) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    order_id VARCHAR(100),
    decided_by VARCHAR(120), decided_via VARCHAR(10),
    decided_app_id BIGINT NULL REFERENCES api_apps(id) ON DELETE SET NULL,
    decided_user_id BIGINT NULL REFERENCES users(id) ON DELETE SET NULL,
    notes TEXT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    decided_at TIMESTAMPTZ NULL,
    UNIQUE (subject_type, subject_id, stage)
  )`);
  await q(`CREATE INDEX IF NOT EXISTS ix_api_approvals_status ON api_approvals (status, created_at)`);
}
