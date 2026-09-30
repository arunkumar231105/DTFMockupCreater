// Stored files (artworks, mockups, gang sheets, export packages) and the signed,
// expiring links they are handed out through. A link carries no credentials and
// works for anyone holding it until it expires — that is what lets a CRM show a
// mockup to a customer — so links are short-lived and re-issued by /api/jobs.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { q, one, newId } from './db.js';

export const DATA_DIR = process.env.DATA_DIR || '/data';
export const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || 'https://designstudio.decoinkssuite.com').replace(/\/$/, '');
export const LINK_TTL_SECONDS = Number(process.env.LINK_TTL_SECONDS || 7 * 86400);
export const RETENTION_DAYS = Number(process.env.RETENTION_DAYS || 90);

let signingKey;
export async function initStorage() {
  await fs.mkdir(path.join(DATA_DIR, 'files'), { recursive: true });
  const keyFile = path.join(DATA_DIR, 'signing.key');
  try { signingKey = await fs.readFile(keyFile); }
  catch {
    signingKey = crypto.randomBytes(32);
    await fs.writeFile(keyFile, signingKey, { mode: 0o600 });
  }
}

export async function saveFile({ ownerType, ownerId, kind, buffer, fileName, contentType = 'image/png' }) {
  const id = newId('F');
  const rel = path.join('files', id.slice(2, 4), `${id}${path.extname(fileName) || ''}`);
  await fs.mkdir(path.join(DATA_DIR, path.dirname(rel)), { recursive: true });
  await fs.writeFile(path.join(DATA_DIR, rel), buffer);
  await q('INSERT INTO api_files (id, owner_type, owner_id, kind, path, file_name, content_type, bytes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [id, ownerType, ownerId, kind, rel, fileName, contentType, buffer.length]);
  return id;
}

export const fileRow = (id) => one('SELECT * FROM api_files WHERE id = $1', [id]);
export const filesOf = async (ownerType, ownerId) => (await q('SELECT * FROM api_files WHERE owner_type = $1 AND owner_id = $2 ORDER BY created_at, id', [ownerType, ownerId])).rows;
export const readFile = (row) => fs.readFile(path.join(DATA_DIR, row.path));
export const filePath = (row) => path.join(DATA_DIR, row.path);

const sign = (id, exp) => crypto.createHmac('sha256', signingKey).update(`${id}.${exp}`).digest('base64url');

export function signedUrl(fileId, ttl = LINK_TTL_SECONDS) {
  const exp = Math.floor(Date.now() / 1000) + ttl;
  return `${PUBLIC_BASE_URL}/api/files/${fileId}?exp=${exp}&sig=${sign(fileId, exp)}`;
}

export function verifySignature(fileId, exp, sig) {
  if (!/^\d+$/.test(String(exp || '')) || Number(exp) < Date.now() / 1000) return false;
  const expected = Buffer.from(sign(fileId, exp));
  const given = Buffer.from(String(sig || ''));
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

export const linkExpiry = () => new Date(Date.now() + LINK_TTL_SECONDS * 1000).toISOString();

/** Delete stored files older than RETENTION_DAYS (their DB rows go too). */
export async function sweepRetention() {
  const { rows } = await q(`DELETE FROM api_files WHERE created_at < NOW() - ($1 || ' days')::interval RETURNING path`, [String(RETENTION_DAYS)]);
  for (const r of rows) await fs.rm(path.join(DATA_DIR, r.path), { force: true });
  return rows.length;
}

/** For files written by a stream (export ZIPs): reserve a path, then register it. */
export async function reserveFile(ext) {
  const id = newId('F');
  const rel = path.join('files', id.slice(2, 4), `${id}${ext}`);
  await fs.mkdir(path.join(DATA_DIR, path.dirname(rel)), { recursive: true });
  return { id, rel, abs: path.join(DATA_DIR, rel) };
}

export async function registerFile({ id, rel, ownerType, ownerId, kind, fileName, contentType }) {
  const { size } = await fs.stat(path.join(DATA_DIR, rel));
  await q('INSERT INTO api_files (id, owner_type, owner_id, kind, path, file_name, content_type, bytes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [id, ownerType, ownerId, kind, rel, fileName, contentType, size]);
  return id;
}
