// Design Studio API — the production engine other systems (CRM, AI agents) call
// for exact mockups and gang sheets. Paths follow the Decoinks API/WebMCP roadmap:
//
//   POST /api/artworks/analyze     POST /api/artworks/prepare     GET /api/artworks/{id}
//   POST /api/mockups/generate     POST /api/mockups/batch        GET /api/mockups/options
//   POST /api/gangsheets/create    GET  /api/jobs/{job_id}        GET /api/jobs?order_id=
//   POST /api/exports/package      GET  /api/approvals            POST /api/approvals/{id}/decide
//   GET  /api/files/{id}?exp&sig   (signed links)                 POST /mcp (AI tools)
//
// Callers are apps from the studio's API Apps page (key + secret, per-app
// permissions) or signed-in studio staff (Design Jobs page, WebMCP in the studio).
import crypto from 'node:crypto';
import express from 'express';
import multer from 'multer';
import { ImageData, GlobalFonts } from '@napi-rs/canvas';

// The studio's tint and background-removal engines build browser ImageData objects.
globalThis.ImageData = ImageData;
for (const f of ['LiberationSans-Regular.ttf', 'LiberationSans-Bold.ttf']) {
  try { GlobalFonts.registerFromPath(`/usr/share/fonts/truetype/liberation/${f}`, 'Arial'); } catch { /* dev box */ }
}

const { ApiError, bad } = await import('./common.js');
const { q, one, ensureSchema, pool } = await import('./db.js');
const { initStorage, verifySignature, fileRow, filePath, sweepRetention } = await import('./storage.js');
const svc = await import('./services.js');
const { resumeJobs } = await import('./jobs.js');
const { statusOf } = await import('./approvals.js');
const { handleMcp } = await import('./mcp.js');
const { MAX_UPLOAD_BYTES } = await import('./inputs.js');

const PORT = Number(process.env.PORT || 8080);
const RATE_PER_MINUTE = Number(process.env.RATE_PER_MINUTE || 60);
const STAFF_RATE_PER_MINUTE = Number(process.env.STAFF_RATE_PER_MINUTE || 240);
const APP_SCOPES_ALL = ['artwork', 'mockup', 'gangsheet', 'export', 'approve'];

// ─── Auth ────────────────────────────────────────────────────────────────────
function credentials(req) {
  let key = req.get('x-api-key'), secret = req.get('x-api-secret'), session = null;
  const auth = (req.get('authorization') || '').trim();
  if ((!key || !secret) && auth.startsWith('Basic ')) {
    const [k, ...rest] = Buffer.from(auth.slice(6), 'base64').toString('utf8').split(':');
    key = k; secret = rest.join(':');
  } else if ((!key || !secret) && auth.startsWith('Bearer ')) {
    const t = auth.slice(7).trim();
    const m = t.match(/^(dsk_[0-9a-f]{32})[:.](dss_[0-9a-f]{64})$/);
    if (m) { key = m[1]; secret = m[2]; } else session = t;
  }
  // Some MCP clients can only be given a URL.
  if ((!key || !secret) && !session && req.path === '/mcp' && req.query.token) {
    const m = String(req.query.token).match(/^(dsk_[0-9a-f]{32})[:.](dss_[0-9a-f]{64})$/);
    if (m) { key = m[1]; secret = m[2]; }
  }
  return { key: (key || '').trim(), secret: (secret || '').trim(), session };
}

async function authenticate(req) {
  const { key, secret, session } = credentials(req);
  const requestedBy = (req.get('x-requested-by') || req.body?.requested_by || '').toString().trim().slice(0, 120) || null;
  if (session) {
    const user = await one(`SELECT u.id, u.username, u.full_name, u.role, u.page_access FROM sessions s JOIN users u ON s.user_id = u.id
                            WHERE s.token = $1 AND s.expires_at > NOW() AND u.is_active = TRUE`, [session]);
    if (!user) throw new ApiError(401, 'invalid_session', 'Your Design Studio session has expired. Reload the page.');
    const pages = Array.isArray(user.page_access) ? user.page_access : [];
    if (user.role !== 'superadmin' && !pages.includes('apijobs')) throw new ApiError(403, 'no_access', 'You need the "Design Jobs" page to use this.');
    const name = user.full_name || user.username;
    return { isStaff: true, userId: Number(user.id), userName: name, appId: null, scopes: APP_SCOPES_ALL,
      via: req.get('x-ds-via') === 'webmcp' ? 'webmcp' : 'studio', requestedBy: requestedBy || name, rateKey: `user:${user.id}` };
  }
  if (!key || !secret) throw new ApiError(401, 'missing_credentials', 'Send your app credentials in the X-API-Key and X-API-Secret headers.');
  const app = await one('SELECT id, name, secret_hash, scopes, is_active FROM api_apps WHERE api_key = $1 AND deleted_at IS NULL', [key]);
  const given = crypto.createHash('sha256').update(secret).digest();
  const expected = app ? Buffer.from(app.secret_hash, 'hex') : crypto.randomBytes(32);
  if (!app || !crypto.timingSafeEqual(given, expected)) throw new ApiError(401, 'invalid_credentials', 'API key or secret is wrong.');
  if (!app.is_active) throw new ApiError(403, 'app_disabled', 'This app has been disabled in Design Studio.');
  return { isStaff: false, appId: Number(app.id), appName: app.name, userId: null, scopes: app.scopes, via: 'api',
    requestedBy: requestedBy || app.name, rateKey: `app:${app.id}` };
}

const buckets = new Map();
function rateLimit(key, limit = RATE_PER_MINUTE) {
  const now = Date.now();
  const b = buckets.get(key) || { start: now, count: 0 };
  if (now - b.start >= 60_000) { b.start = now; b.count = 0; }
  b.count += 1;
  buckets.set(key, b);
  if (b.count > limit) throw new ApiError(429, 'rate_limited', `Limit is ${limit} requests per minute.`);
}

async function logRequest(req, status, started, detail) {
  if (!req.ctx?.appId) return;
  try {
    await q('INSERT INTO api_request_log (app_id, endpoint, status, duration_ms, detail) VALUES ($1, $2, $3, $4, $5)',
      [req.ctx.appId, `${req.method} ${req.originalUrl.split('?')[0]}`.slice(0, 60), status, Date.now() - started, detail ? String(detail).slice(0, 500) : null]);
    await q('UPDATE api_apps SET last_used_at = NOW(), request_count = request_count + 1 WHERE id = $1', [req.ctx.appId]);
  } catch (e) { console.error('[log]', e.message); }
}

// ─── App ─────────────────────────────────────────────────────────────────────
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback');
app.use(express.json({ limit: '80mb' }));
app.use(express.urlencoded({ extended: false, limit: '80mb' }));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES, files: 25, fields: 80 } });

app.use((req, res, next) => {
  const started = Date.now();
  res.on('finish', () => logRequest(req, res.statusCode, started, res.locals.logDetail));
  next();
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));

// Signed links: no credentials, just a valid unexpired signature.
app.get('/api/files/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!/^F_[0-9A-Z]{12}$/.test(id) || !verifySignature(id, req.query.exp, req.query.sig)) throw new ApiError(403, 'invalid_link', 'This link is invalid or has expired. Get a fresh one from /api/jobs/{job_id}.');
    const f = await fileRow(id);
    if (!f) throw new ApiError(404, 'not_found', 'This file is past its retention period.');
    if (f.kind === 'sheet_print' && await statusOf('gangsheet', f.owner_id, 'qa') !== 'approved') {
      throw new ApiError(403, 'qa_required', 'Print files are released only after QA approval.');
    }
    const inline = f.content_type.startsWith('image/');
    res.set({ 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${f.file_name.replace(/"/g, '')}"` });
    res.type(f.content_type).sendFile(filePath(f));
  } catch (e) { next(e); }
});

const auth = async (req, _res, next) => {
  try { req.ctx = await authenticate(req); rateLimit(req.ctx.rateKey, req.ctx.isStaff ? STAFF_RATE_PER_MINUTE : RATE_PER_MINUTE); next(); } catch (e) { next(e); }
};

// Job views answer 200 when ready, 202 while queued/processing, 500 when failed.
const sendJob = (res, view) => {
  if (view.status === 'failed') return res.status(500).json({ error: { code: 'job_failed', message: view.error || 'The job failed.', job_id: view.job_id }, job: view });
  res.status(['queued', 'processing'].includes(view.status) ? 202 : 200).json(view);
};
const h = (fn) => async (req, res, next) => { try { await fn(req, res); } catch (e) { next(e); } };

const api = express.Router();
api.use(auth);
api.get('/me', h(async (req, res) => res.json({
  ...(req.ctx.isStaff ? { user: { id: req.ctx.userId, name: req.ctx.userName } } : { app: { id: req.ctx.appId, name: req.ctx.appName } }),
  scopes: req.ctx.scopes,
})));
api.post('/artworks/analyze', upload.any(), h(async (req, res) => res.json(await svc.analyzeArtwork(req.ctx, req.body || {}, req.files || []))));
api.post('/artworks/prepare', h(async (req, res) => res.json(await svc.prepare(req.ctx, req.body || {}))));
api.get('/artworks/:id', h(async (req, res) => res.json(await svc.analyzeArtwork(req.ctx, { artwork_id: req.params.id }))));
api.get('/mockups/options', h(async (req, res) => res.json(await svc.mockupOptions(req.ctx))));
api.post('/mockups/generate', upload.any(), h(async (req, res) => {
  const view = await svc.generateMockup(req.ctx, req.body || {}, req.files || []);
  res.locals.logDetail = view.job_id;
  sendJob(res, view);
}));
api.post('/mockups/batch', h(async (req, res) => sendJob(res, await svc.batchMockups(req.ctx, req.body || {}))));
api.post('/gangsheets/create', upload.any(), h(async (req, res) => {
  const view = await svc.createGangsheet(req.ctx, req.body || {}, req.files || []);
  res.locals.logDetail = view.job_id;
  sendJob(res, view);
}));
api.get('/jobs', h(async (req, res) => res.json(await svc.jobsList(req.ctx, req.query))));
api.get('/jobs/:id', h(async (req, res) => res.json(await svc.jobStatus(req.ctx, req.params.id))));
api.post('/exports/package', h(async (req, res) => sendJob(res, await svc.exportPackage(req.ctx, req.body || {}))));
api.get('/approvals', h(async (req, res) => res.json(await svc.approvals(req.ctx, req.query))));
api.post('/approvals/:id/decide', h(async (req, res) => res.json(await svc.decideApproval(req.ctx, req.params.id, req.body || {}))));
app.use('/api', api);

app.all('/mcp', auth, h(async (req, res) => handleMcp(req, res, req.ctx)));

app.use((_req, _res, next) => next(new ApiError(404, 'not_found', 'No such endpoint. See /api/mockups/generate, /api/gangsheets/create, /api/artworks/analyze.')));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  let e = err;
  if (err instanceof multer.MulterError) e = bad(err.code === 'LIMIT_FILE_SIZE' ? 'Each file must be 50 MB or smaller.' : err.message, 'upload_error');
  else if (err.type === 'entity.too.large') e = bad('Request body is larger than 80 MB.', 'upload_error');
  else if (err.type === 'entity.parse.failed') e = bad('Request body is not valid JSON.');
  else if (!(err instanceof ApiError)) { console.error('[error]', err); e = new ApiError(500, 'internal_error', 'Something went wrong. Try again, or contact Design Studio admins.'); }
  res.locals.logDetail = e.message;
  if (res.headersSent) return;
  res.status(e.status).json({ error: { code: e.code, message: e.message, ...(e.extra || {}) } });
});

// ─── Start ───────────────────────────────────────────────────────────────────
await ensureSchema();
await initStorage();
const resumed = await resumeJobs();
setInterval(() => sweepRetention().catch(e => console.error('[retention]', e.message)), 6 * 3600_000).unref();
sweepRetention().catch(() => {});
app.listen(PORT, () => console.log(`Design Studio API on :${PORT} (resumed ${resumed} job(s))`));
process.on('SIGTERM', async () => { await pool.end().catch(() => {}); process.exit(0); });
