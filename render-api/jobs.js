// Jobs: every mockup, gang sheet, batch and export is a stored job with its full
// input, the app/agent that asked, the engine version and its warnings. Requests
// are validated and normalised up front (so a stored input is always runnable);
// the runner then executes it. Jobs left queued/processing by a restart are
// picked up again at startup.
import crypto from 'node:crypto';
import fs from 'node:fs';
import archiver from 'archiver';
import { ApiError, bad, withDpi } from './common.js';
import { q, one, newId } from './db.js';
import { saveFile, filesOf, signedUrl, filePath, reserveFile, registerFile, fileRow } from './storage.js';
import { createApproval, approvalsFor, statusOf, gangsheetItemProblems } from './approvals.js';
import { getArtwork, artworkImage } from './artworks.js';
import { garmentLibrary, publicGarment, resolveGarment, placementFor, printSize, renderMockup, labelLines, CANVAS_WIDTH, CANVAS_HEIGHT } from './mockup.js';
import { layoutGangSheet, renderSheet, sheetHeightInches, previewOf, DPI, COST_PER_FOOT } from './gangsheet.js';

export const ENGINE_VERSION = 'design-studio-render/2.0';
const w = (code, message) => ({ code, message });

// ─── Runner ──────────────────────────────────────────────────────────────────
const CONCURRENCY = { mockup: 2, gangsheet: 1, batch: 1, export: 1 };
const queues = Object.fromEntries(Object.keys(CONCURRENCY).map(t => [t, { active: 0, waiting: [] }]));
const done = new Map(); // job id → { promise, resolve }

function waiter(id) {
  if (!done.has(id)) { let resolve; const promise = new Promise(r => { resolve = r; }); done.set(id, { promise, resolve }); }
  return done.get(id);
}

function enqueue(job) {
  waiter(job.id);
  queues[job.type].waiting.push(job.id);
  pump(job.type);
}

function pump(type) {
  const Q = queues[type];
  while (Q.active < CONCURRENCY[type] && Q.waiting.length) {
    const id = Q.waiting.shift();
    Q.active += 1;
    run(id).finally(() => { Q.active -= 1; pump(type); });
  }
}

async function run(id) {
  const job = await one(`UPDATE api_jobs SET status = 'processing', started_at = NOW() WHERE id = $1 AND status IN ('queued','processing') RETURNING *`, [id]);
  if (!job) return;
  try {
    const { result, warnings } = await EXECUTORS[job.type](job);
    const allWarnings = [...(job.warnings || []), ...(warnings || [])];
    await q(`UPDATE api_jobs SET status = $2, result = $3, warnings = $4, finished_at = NOW() WHERE id = $1`,
      [id, result.status || 'ready', { ...result, status: undefined }, JSON.stringify(allWarnings)]);
  } catch (e) {
    const msg = e instanceof ApiError ? e.message : 'Rendering failed unexpectedly.';
    if (!(e instanceof ApiError)) console.error(`[job ${id}]`, e);
    await q(`UPDATE api_jobs SET status = 'failed', error = $2, finished_at = NOW() WHERE id = $1`, [id, msg]);
  } finally {
    done.get(id)?.resolve();
    setTimeout(() => done.delete(id), 60_000);
  }
}

export async function resumeJobs() {
  const { rows } = await q(`SELECT id, type FROM api_jobs WHERE status IN ('queued','processing') ORDER BY created_at`);
  for (const r of rows) enqueue(r);
  return rows.length;
}

const hashInput = (type, ctx, input) => crypto.createHash('sha256')
  .update(JSON.stringify({ type, owner: ctx.appId ? `app:${ctx.appId}` : `user:${ctx.userId}`, input, engine: ENGINE_VERSION })).digest('hex');

/** Create (or reuse the identical) job, run it, and optionally wait for it. */
export async function submitJob(ctx, { type, input, meta = {}, warnings = [], wait = false, dedupe = true, parentJobId = null }) {
  const inputHash = hashInput(type, ctx, { ...input, _meta: meta });
  if (dedupe && !meta.force_new) {
    const existing = await one(`SELECT * FROM api_jobs WHERE COALESCE(app_id, 0) = $1 AND input_hash = $2 AND type = $3 AND status IN ('queued','processing','ready')
                               ORDER BY created_at DESC LIMIT 1`, [ctx.appId || 0, inputHash, type]);
    if (existing) {
      if (wait && existing.status !== 'ready') await Promise.race([waiter(existing.id).promise, sleep(wait)]);
      return { job: await one('SELECT * FROM api_jobs WHERE id = $1', [existing.id]), reused: true };
    }
  }
  const queued = await one(`SELECT COUNT(*)::int AS n FROM api_jobs WHERE COALESCE(app_id, 0) = $1 AND status IN ('queued','processing') AND parent_job_id IS NULL`, [ctx.appId || 0]);
  if (!parentJobId && queued.n >= 50) throw new ApiError(429, 'too_many_queued', 'This app already has 50 jobs waiting. Wait for some to finish.');

  const prefix = { mockup: 'MJ', gangsheet: 'GJ', batch: 'BJ', export: 'EJ' }[type];
  const job = await one(`INSERT INTO api_jobs (id, type, app_id, user_id, via, requested_by, order_id, customer_id, lead_id, parent_job_id, input, input_hash, warnings, engine_version)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
  [newId(prefix), type, ctx.appId, ctx.userId, ctx.via, ctx.requestedBy, meta.order_id || null, meta.customer_id || null, meta.lead_id || null,
    parentJobId, input, inputHash, JSON.stringify(warnings), ENGINE_VERSION]);
  enqueue(job);
  if (wait) await Promise.race([waiter(job.id).promise, sleep(wait)]);
  return { job: await one('SELECT * FROM api_jobs WHERE id = $1', [job.id]), reused: false };
}

const sleep = (ms) => new Promise(r => setTimeout(r, typeof ms === 'number' ? ms : 120_000));

export async function getJob(ctx, id) {
  if (!/^(MJ|GJ|BJ|EJ)_[0-9A-Z]{12}$/.test(String(id || ''))) throw new ApiError(404, 'unknown_job', `"${id}" is not a job id.`);
  const job = await one('SELECT * FROM api_jobs WHERE id = $1', [id]);
  if (!job || (!ctx.isStaff && Number(job.app_id) !== ctx.appId)) throw new ApiError(404, 'unknown_job', `Job ${id} not found.`);
  return job;
}

export async function listJobs(ctx, { order_id, type, status, limit = 50, top_level = true }) {
  const params = []; const where = [];
  if (!ctx.isStaff) { params.push(ctx.appId); where.push(`app_id = $${params.length}`); }
  if (order_id) { params.push(order_id); where.push(`order_id = $${params.length}`); }
  if (type) { params.push(type); where.push(`type = $${params.length}`); }
  if (status) { params.push(status); where.push(`status = $${params.length}`); }
  if (top_level) where.push('parent_job_id IS NULL');
  params.push(Math.min(Number(limit) || 50, 200));
  const { rows } = await q(`SELECT * FROM api_jobs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT $${params.length}`, params);
  return rows;
}

// ─── Views ───────────────────────────────────────────────────────────────────
export async function jobView(job, { brief = false } = {}) {
  const base = {
    job_id: job.id, type: job.type, status: job.status,
    order_id: job.order_id, customer_id: job.customer_id, lead_id: job.lead_id,
    requested_by: job.requested_by, via: job.via, engine_version: job.engine_version,
    created_at: job.created_at, finished_at: job.finished_at,
    warnings: job.warnings || [], error: job.error || undefined,
  };
  const r = job.result || {};
  const files = job.status === 'ready' ? await filesOf('job', job.id) : [];
  if (job.type === 'mockup') {
    const f = files.find(x => x.kind === 'mockup');
    const approvals = await approvalsFor('mockup', job.id);
    return {
      ...base,
      mockup_url: f ? signedUrl(f.id) : null,
      final_print_width_in: r.final_print_width_in ?? null,
      final_print_height_in: r.final_print_height_in ?? null,
      requested_print_width_in: job.input.requested_print_width_in ?? null,
      scale_status: r.scale_status ?? null,
      agent_status: approvals.agent_review.status,
      customer_status: approvals.customer.status,
      ...(brief ? {} : { garment: r.garment, placement: r.placement, artwork: r.artwork, image: r.image, label: job.input.generate_label, approvals }),
    };
  }
  if (job.type === 'gangsheet') {
    const approvals = await approvalsFor('gangsheet', job.id);
    const released = approvals.qa.status === 'approved';
    const sheets = (r.sheets || []).map(s => {
      const preview = files.find(x => x.id === s.preview_file_id);
      const print = files.find(x => x.id === s.print_file_id);
      return { ...s, preview_file_id: undefined, print_file_id: undefined,
        preview_url: preview ? signedUrl(preview.id) : null,
        print_url: released && print ? signedUrl(print.id) : null };
    });
    return {
      ...base,
      nesting_status: job.status,
      film_width_in: job.input.film_width_in,
      length_in: r.total_length_in ?? null,
      qa_status: approvals.qa.status,
      output_url: sheets[0]?.print_url || null,
      print_files_released: released,
      ...(brief ? { total_sheets: sheets.length } : { sheets, layout: r.layout, artwork_list: r.artwork_list, approvals }),
    };
  }
  if (job.type === 'batch') {
    const { rows } = await q('SELECT * FROM api_jobs WHERE parent_job_id = $1 ORDER BY created_at', [job.id]);
    const children = await Promise.all(rows.map(c => jobView(c, { brief: true })));
    return { ...base, total: children.length, ready: children.filter(c => c.status === 'ready').length,
      failed: children.filter(c => c.status === 'failed').length, mockups: brief ? undefined : children };
  }
  if (job.type === 'export') {
    const f = files.find(x => x.kind === 'package');
    return { ...base, output_type: job.input.output_type, package_url: f ? signedUrl(f.id) : null, contents: brief ? undefined : r.contents };
  }
  return base;
}

// ─── Mockups ─────────────────────────────────────────────────────────────────
const ANALYSIS_TO_MOCKUP = {
  WHITE_BACKGROUND: 'ARTWORK_WHITE_BACKGROUND', SOLID_BACKGROUND: 'ARTWORK_SOLID_BACKGROUND',
  FAKE_CHECKERBOARD_BACKGROUND: 'ARTWORK_FAKE_CHECKERBOARD', NO_TRANSPARENT_BACKGROUND: 'ARTWORK_NOT_TRANSPARENT',
  SEMI_TRANSPARENT_PIXELS: 'ARTWORK_SEMI_TRANSPARENT', EXCESS_PADDING: 'ARTWORK_EXCESS_PADDING',
};

async function executeMockup(job) {
  const input = job.input;
  const art = await one('SELECT * FROM api_artworks WHERE id = $1', [input.artwork_id]);
  if (!art) throw new ApiError(410, 'artwork_gone', `Artwork ${input.artwork_id} no longer exists.`);
  const { image } = await artworkImage(art);
  const warnings = [];
  const library = await garmentLibrary();
  let resolved;
  try { resolved = resolveGarment(library, { ...input.garment, size: input.size, side: input.side }); }
  catch (e) { throw bad(e.message, e.code || 'unknown_garment'); }
  warnings.push(...resolved.warnings);
  const placement = placementFor(input.placement, input.size, {
    side: input.side, custom_x_in: input.custom_x_in, custom_y_in: input.custom_y_in,
    max_width_in: input.max_print_width_in, max_height_in: input.max_print_height_in,
  });
  const aspect = art.width_px / art.height_px;
  const print = printSize(aspect, placement, { width_in: input.requested_print_width_in, height_in: input.requested_print_height_in });
  warnings.push(...print.warnings);
  for (const aw of art.analysis.warnings || []) if (ANALYSIS_TO_MOCKUP[aw.code]) warnings.push(w(ANALYSIS_TO_MOCKUP[aw.code], aw.message));
  if (art.review_status === 'pending_review') warnings.push(w('ARTWORK_PENDING_REVIEW', `${art.id} had its background removed and has not been reviewed yet.`));
  if (art.review_status === 'rejected') warnings.push(w('ARTWORK_REJECTED', `${art.id} was rejected in review.`));
  const effectiveDpi = Math.round(art.width_px / print.width_in);
  if (effectiveDpi < 150) warnings.push(w('LOW_EFFECTIVE_DPI', `At ${print.width_in}" wide the artwork is ${effectiveDpi} DPI; it will print soft (150+ recommended, 300 ideal).`));

  const garmentName = input.garment.garment_style || resolved.garment?.name || input.garment.garment_type || 'T-Shirt';
  const label = input.generate_label ? labelLines({ garmentName, color: input.color, size: input.size, side: input.side, placement, print,
    requestedWidth: input.requested_print_width_in, artworkRow: art, orderId: job.order_id, jobId: job.id }) : null;
  const { canvas, outside } = await renderMockup({ artwork: image, size: input.size, color: input.color, side: input.side,
    garment: resolved.garment, placement, print, background: input.background, label });
  if (outside) warnings.push(w('PRINT_OUTSIDE_GARMENT', 'Part of the print falls outside the garment photo — check the placement.'));
  const png = await canvas.encode('png');
  await saveFile({ ownerType: 'job', ownerId: job.id, kind: 'mockup', buffer: png,
    fileName: `${job.id}-${input.size}-${input.side}-${input.placement}.png` });
  await createApproval({ subjectType: 'mockup', subjectId: job.id, stage: 'agent_review', orderId: job.order_id });
  return {
    warnings,
    result: {
      final_print_width_in: print.width_in, final_print_height_in: print.height_in, scale_status: print.scale_status,
      garment: {
        style: input.garment.garment_style || null, type: resolved.garment?.type || input.garment.garment_type, size: input.size,
        color: input.color.name, color_hex: input.color.hex, side: input.side,
        photo: resolved.garment ? publicGarment(resolved.garment) : null,
      },
      placement: { name: placement.name, center_x_in: placement.center_x_in, top_in: placement.top_in, max_width_in: placement.max_width_in, max_height_in: placement.max_height_in },
      artwork: { artwork_id: art.id, width_px: art.width_px, height_px: art.height_px, aspect_ratio: art.analysis.aspect_ratio, ratio: art.analysis.ratio, effective_dpi: effectiveDpi, review_status: art.review_status },
      image: { width_px: CANVAS_WIDTH, height_px: CANVAS_HEIGHT, format: 'png', bytes: png.length },
    },
  };
}

// ─── Gang sheets ─────────────────────────────────────────────────────────────
async function executeGangsheet(job) {
  const input = job.input;
  const artworks = [];
  for (const [i, it] of input.items.entries()) {
    const art = await one('SELECT * FROM api_artworks WHERE id = $1', [it.artwork_id]);
    if (!art) throw new ApiError(410, 'artwork_gone', `Artwork ${it.artwork_id} no longer exists.`);
    const { image } = await artworkImage(art);
    artworks.push({ id: i, name: it.name, image, widthInches: it.width_in, heightInches: it.height_in, quantity: it.quantity, artworkId: art.id });
  }
  const opts = { hGap: input.h_gap_in, vGap: input.v_gap_in, margins: input.margins, filmWidth: input.film_width_in, maxLength: input.max_length_in };
  const layout = layoutGangSheet(artworks, opts);
  if (layout.totalSheets > 10) throw bad(`This job needs ${layout.totalSheets} sheets; at most 10 are rendered per job. Split it up.`, 'too_many_sheets');
  const header = { include: input.header.include, topMargin: input.header.top_margin_in, poNumber: input.header.po_number, orderNumber: input.header.order_number || job.order_id || '', orderLink: input.header.order_link };
  const sheets = [];
  let itemArea = 0;
  for (let i = 0; i < layout.sheets.length; i++) {
    const sheet = layout.sheets[i];
    if (!sheet.items.length) continue;
    const lengthIn = sheetHeightInches(sheet, header);
    const canvas = await renderSheet(sheet, i, layout.totalSheets, artworks, header, input.film_width_in);
    const print = withDpi(await canvas.encode('png'), DPI);
    const name = `${job.id}-sheet${i + 1}-${input.film_width_in}x${Math.ceil(lengthIn)}-${DPI}dpi.png`;
    const printId = await saveFile({ ownerType: 'job', ownerId: job.id, kind: 'sheet_print', buffer: print, fileName: name });
    const previewId = await saveFile({ ownerType: 'job', ownerId: job.id, kind: 'sheet_preview', buffer: await previewOf(canvas), fileName: name.replace('.png', '-preview.png') });
    sheet.items.forEach(p => { itemArea += p.w * p.h; });
    sheets.push({
      index: i + 1, width_in: input.film_width_in, length_in: +lengthIn.toFixed(2), width_px: canvas.width, height_px: canvas.height, dpi: DPI,
      pieces: sheet.items.length, print_bytes: print.length, print_file_id: printId, preview_file_id: previewId,
      placements: sheet.items.map(p => ({ item: p.artworkId, artwork_id: artworks[p.artworkId].artworkId, x_in: +p.x.toFixed(3), y_in: +p.y.toFixed(3), width_in: p.w, height_in: p.h, rotated: !!p.rotated })),
    });
  }
  const totalLength = sheets.reduce((s, x) => s + x.length_in, 0);
  await createApproval({ subjectType: 'gangsheet', subjectId: job.id, stage: 'qa', orderId: job.order_id });
  return {
    result: {
      total_length_in: +totalLength.toFixed(2),
      sheets,
      artwork_list: input.items.map((it, i) => ({ item: i, artwork_id: it.artwork_id, mockup_job_id: it.mockup_job_id, name: it.name, width_in: it.width_in, height_in: it.height_in, quantity: it.quantity })),
      layout: {
        total_sheets: sheets.length, total_pieces: input.items.reduce((s, it) => s + it.quantity, 0),
        packing_strategy: layout.strategy?.name || null,
        film_utilization: totalLength ? +(itemArea / (input.film_width_in * totalLength)).toFixed(3) : 0,
        estimated_price: Math.ceil(totalLength / 12) * COST_PER_FOOT, price_basis: `$${COST_PER_FOOT} per started linear foot`,
      },
    },
  };
}

// ─── Batch mockups ───────────────────────────────────────────────────────────
async function executeBatch(job) {
  const ctx = { appId: job.app_id ? Number(job.app_id) : null, userId: job.user_id ? Number(job.user_id) : null, via: job.via, requestedBy: job.requested_by, isStaff: false };
  const meta = { order_id: job.order_id, customer_id: job.customer_id, lead_id: job.lead_id };
  // After a restart the children may already exist (some finished): reuse them.
  let children = (await q('SELECT id FROM api_jobs WHERE parent_job_id = $1', [job.id])).rows.map(r => r.id);
  if (!children.length) {
    for (const input of job.input.mockups) {
      const { job: child } = await submitJob(ctx, { type: 'mockup', input, meta, parentJobId: job.id, dedupe: false });
      children.push(child.id);
    }
  }
  for (;;) {
    const open = await one(`SELECT COUNT(*)::int AS n FROM api_jobs WHERE parent_job_id = $1 AND status IN ('queued','processing')`, [job.id]);
    if (!open.n) break;
    await new Promise(r => setTimeout(r, 400));
  }
  const { rows } = await q(`SELECT status FROM api_jobs WHERE parent_job_id = $1`, [job.id]);
  const failed = rows.filter(r => r.status === 'failed').length;
  return { result: { status: failed === rows.length ? 'failed' : 'ready', children: children.length, failed } };
}

// ─── Export packages ─────────────────────────────────────────────────────────
/** Which of these jobs may go into a package of this type (approval gates). */
export async function exportable(jobs, outputType) {
  const include = [], skipped = [];
  for (const j of jobs) {
    if (outputType === 'customer_preview') {
      if (j.type !== 'mockup' || j.status !== 'ready') { skipped.push({ job_id: j.id, reason: j.type !== 'mockup' ? 'not a mockup' : `status ${j.status}` }); continue; }
      const agent = await statusOf('mockup', j.id, 'agent_review');
      if (agent !== 'approved') skipped.push({ job_id: j.id, reason: `agent approval is ${agent || 'missing'} — a person must approve a mockup before it goes to the customer` });
      else include.push(j);
    } else {
      if (j.type !== 'gangsheet' || j.status !== 'ready') { skipped.push({ job_id: j.id, reason: j.type !== 'gangsheet' ? 'not a gang sheet' : `status ${j.status}` }); continue; }
      const qa = await statusOf('gangsheet', j.id, 'qa');
      if (qa !== 'approved') skipped.push({ job_id: j.id, reason: `QA approval is ${qa || 'missing'}` });
      else include.push(j);
    }
  }
  return { include, skipped };
}

const csv = (rows) => rows.map(r => r.map(v => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}).join(',')).join('\n') + '\n';

async function executeExport(job) {
  const { rows: jobs } = await q('SELECT * FROM api_jobs WHERE id = ANY($1::text[]) ORDER BY created_at', [job.input.job_ids]);
  const { include, skipped } = await exportable(jobs, job.input.output_type);
  if (!include.length) throw new ApiError(409, 'approval_required', 'Nothing in this package passed its approval gate any more.');
  const res = await reserveFile('.zip');
  const out = fs.createWriteStream(res.abs);
  const zip = archiver('zip', { store: true });
  const finished = new Promise((resolve, reject) => { out.on('close', resolve); zip.on('error', reject); out.on('error', reject); });
  zip.pipe(out);
  const contents = [];
  if (job.input.output_type === 'customer_preview') {
    const report = [['job_id', 'order_id', 'artwork_id', 'garment', 'color', 'size', 'side', 'placement', 'requested_width_in', 'final_width_in', 'final_height_in', 'scale_status', 'artwork_px', 'effective_dpi', 'agent_approved_by', 'customer_status', 'warnings']];
    for (const j of include) {
      const f = (await filesOf('job', j.id)).find(x => x.kind === 'mockup');
      const r = j.result;
      const name = `mockups/${j.id}-${r.garment.color.replace(/[^A-Za-z0-9#]+/g, '_')}-${r.garment.size}-${r.placement.name}.png`;
      zip.file(filePath(f), { name });
      contents.push(name);
      const ap = await approvalsFor('mockup', j.id);
      report.push([j.id, j.order_id, r.artwork.artwork_id, r.garment.style || r.garment.type, r.garment.color, r.garment.size, r.garment.side, r.placement.name,
        j.input.requested_print_width_in, r.final_print_width_in, r.final_print_height_in, r.scale_status, `${r.artwork.width_px}x${r.artwork.height_px}`,
        r.artwork.effective_dpi, ap.agent_review.decided_by, ap.customer.status, (j.warnings || []).map(x => x.code).join(' ')]);
    }
    zip.append(csv(report), { name: 'size_report.csv' }); contents.push('size_report.csv');
  } else {
    const report = [['job_id', 'order_id', 'sheet', 'file', 'film_width_in', 'length_in', 'pieces', 'qa_approved_by']];
    for (const j of include) {
      const files = await filesOf('job', j.id);
      const ap = await approvalsFor('gangsheet', j.id);
      for (const s of j.result.sheets) {
        const f = files.find(x => x.id === s.print_file_id);
        const name = `gangsheets/${f.file_name}`;
        zip.file(filePath(f), { name });
        contents.push(name);
        report.push([j.id, j.order_id, s.index, f.file_name, s.width_in, s.length_in, s.pieces, ap.qa.decided_by]);
      }
    }
    zip.append(csv(report), { name: 'layout_report.csv' }); contents.push('layout_report.csv');
  }
  const allSkipped = [...(job.input.skipped || []), ...skipped];
  zip.append(JSON.stringify({ export_job: job.id, output_type: job.input.output_type, created_at: new Date().toISOString(), included: include.map(j => j.id), skipped: allSkipped }, null, 2), { name: 'summary.json' });
  contents.push('summary.json');
  await zip.finalize();
  await finished;
  await registerFile({ ...res, ownerType: 'job', ownerId: job.id, kind: 'package', fileName: `${job.id}-${job.input.output_type}.zip`, contentType: 'application/zip' });
  return { result: { contents, included: include.map(j => j.id), skipped: allSkipped }, warnings: skipped.map(s => w('SKIPPED', `${s.job_id}: ${s.reason}`)) };
}

const EXECUTORS = { mockup: executeMockup, gangsheet: executeGangsheet, batch: executeBatch, export: executeExport };

export { getArtwork, fileRow, gangsheetItemProblems };
