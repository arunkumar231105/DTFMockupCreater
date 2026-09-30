// The operations themselves, shared by the HTTP API (routes.js) and the AI tool
// layer (mcp.js / WebMCP). Each takes the caller context and a plain body,
// validates everything up front, and returns the public view.
import { ApiError, bad, num, bool, str, jsonField } from './common.js';
import { one, q } from './db.js';
import { artworkBuffer } from './inputs.js';
import { ingestArtwork, getArtwork, artworkView, prepareArtwork } from './artworks.js';
import { submitJob, getJob, listJobs, jobView, exportable } from './jobs.js';
import { decide, listApprovals, statusOf } from './approvals.js';
import { garmentLibrary, publicGarment, resolveColor, resolveSize, PLACEMENTS, placementFor, SIZES, COLORS, CANVAS_WIDTH, CANVAS_HEIGHT } from './mockup.js';
import { defaultItemSize, SHEET_WIDTH_INCHES, MAX_SHEET_HEIGHT } from './gangsheet.js';

const MAX_WAIT_MS = 120_000;
const w = (code, message) => ({ code, message });

export function requireScope(ctx, ...scopes) {
  if (!scopes.some(s => ctx.scopes.includes(s))) {
    throw new ApiError(403, 'scope_denied', `This ${ctx.isStaff ? 'account' : 'app'} is not allowed to do that (needs the ${scopes.join(' or ')} permission).`);
  }
}

const orderMeta = (b) => ({
  order_id: str(b.order_id), customer_id: str(b.customer_id), lead_id: str(b.lead_id), force_new: bool(b.force_new),
});

/** An artwork reference: artwork_id, or inline bytes (stored as a new/reused artwork). */
async function resolveArtworkRef(ctx, b, files = [], label = 'artwork') {
  if (b.artwork_id) return getArtwork(ctx, b.artwork_id);
  const hasInline = b.upload || b.file != null || b.artwork_base64 || b.artwork_url;
  if (!hasInline) throw bad(`${label}: send artwork_id (from /api/artworks/analyze), or the artwork as a file, artwork_url or artwork_base64.`);
  const buf = await artworkBuffer(b, files, label);
  const { row } = await ingestArtwork(ctx, buf, { name: str(b.name || b.upload?.originalname, 200), label, ...orderMeta(b) });
  return row;
}

// ─── Artworks ────────────────────────────────────────────────────────────────
export async function analyzeArtwork(ctx, b, files = []) {
  requireScope(ctx, 'artwork', 'mockup', 'gangsheet');
  if (b.artwork_id) return { ...(await artworkView(await getArtwork(ctx, b.artwork_id))), reused: true };
  const upload = files[0];
  const src = upload ? { upload } : b;
  const hasInline = src.upload || src.artwork_base64 || src.artwork_url;
  if (!hasInline) throw bad('Send the artwork as a file upload, artwork_url or artwork_base64 (or artwork_id to re-read a stored one).');
  const buf = await artworkBuffer(src, files, 'artwork');
  const { row, reused } = await ingestArtwork(ctx, buf, { name: str(b.name || upload?.originalname, 200), ...orderMeta(b) });
  return { ...(await artworkView(row)), reused };
}

export async function prepare(ctx, b) {
  requireScope(ctx, 'artwork');
  if (!b.artwork_id) throw bad('artwork_id is required (analyze the artwork first).');
  const source = await getArtwork(ctx, b.artwork_id);
  const opts = {
    remove_background: str(b.remove_background, 20) || 'none',
    trim: bool(b.trim, true),
    target_print_width_in: num(b.target_print_width_in, 'target_print_width_in', { min: 0.5, max: 24 }),
    target_dpi: num(b.target_dpi, 'target_dpi', { min: 72, max: 600, def: 300 }),
  };
  const { row, warnings } = await prepareArtwork(ctx, source, opts, orderMeta(b));
  return { ...(await artworkView(row)), prep_warnings: warnings, requires_human_review: row.review_status === 'pending_review' };
}

// ─── Mockups ─────────────────────────────────────────────────────────────────
/** Validate one mockup request into the canonical, stored job input. */
export async function normalizeMockup(ctx, b, files = []) {
  const art = await resolveArtworkRef(ctx, files.length ? { ...b, upload: files[0] } : b, files);
  const { size, fit: sizeFit } = resolveSize(b.garment_size ?? b.size);
  if (!size) throw bad(`Unknown garment_size "${b.garment_size ?? b.size}". Use e.g. "Adult L", "L", "2XL", "Youth M", "2T" — see /api/mockups/options.`);
  const color = resolveColor(b.garment_color ?? b.color);
  if (!color) throw bad(`Unknown garment_color "${b.garment_color ?? b.color}". Use a colour name from /api/mockups/options or a hex code like #1e3a5f.`);
  const placementName = str(b.placement, 30)?.toLowerCase().replace(/[\s-]+/g, '_') || null;
  let side = str(b.side, 10)?.toLowerCase() || null;
  if (side && !['front', 'back'].includes(side)) throw bad('side must be front or back.');
  const placement = placementName || (side === 'back' ? 'back_center' : 'front_center');
  if (!PLACEMENTS[placement]) throw bad(`Unknown placement "${b.placement}". Use one of: ${Object.keys(PLACEMENTS).join(', ')}.`);
  const preset = PLACEMENTS[placement];
  if (placement === 'custom') {
    if (!side) throw bad('placement "custom" needs side (front or back).');
    if (b.custom_x_in === undefined || b.custom_y_in === undefined) throw bad('placement "custom" needs custom_x_in (inches from the centre line, + = wearer\'s left) and custom_y_in (inches from the top of the garment).');
  } else if (side && preset.side !== side) throw bad(`placement ${placement} is on the ${preset.side}, but side is ${side}.`);
  side = side || preset.side;
  if (b.garment_id) {
    const g = (await garmentLibrary()).find(x => x.id === b.garment_id);
    if (!g) throw bad(`No garment with id "${b.garment_id}". See /api/mockups/options.`, 'unknown_garment');
  }
  let background = str(b.background, 20) || 'transparent';
  if (background !== 'transparent') {
    const c = resolveColor(background);
    if (!c) throw bad('background must be "transparent" or a colour.');
    background = c.hex;
  }
  const input = {
    artwork_id: art.id,
    garment: { garment_id: str(b.garment_id, 60), garment_style: str(b.garment_style, 80), garment_type: str(b.garment_type, 40) || 'T-Shirt', fit: str(b.garment_fit, 20) || sizeFit },
    size, color, side, placement,
    custom_x_in: placement === 'custom' ? num(b.custom_x_in, 'custom_x_in', { min: -20, max: 20 }) : undefined,
    custom_y_in: placement === 'custom' ? num(b.custom_y_in, 'custom_y_in', { min: 0, max: 40 }) : undefined,
    requested_print_width_in: num(b.requested_print_width_in, 'requested_print_width_in', { min: 0.25, max: 30 }),
    requested_print_height_in: num(b.requested_print_height_in, 'requested_print_height_in', { min: 0.25, max: 40 }),
    max_print_width_in: num(b.max_print_width_in, 'max_print_width_in', { min: 0.25, max: 30 }),
    max_print_height_in: num(b.max_print_height_in, 'max_print_height_in', { min: 0.25, max: 40 }),
    generate_label: bool(b.generate_label, false),
    background,
  };
  if (input.requested_print_width_in && input.requested_print_height_in) throw bad('Send requested_print_width_in or requested_print_height_in, not both — the artwork aspect ratio is always kept.');
  return JSON.parse(JSON.stringify(input));
}

function waitMs(b, def) {
  const v = b.wait;
  if (v === undefined || v === null || v === '') return def ? MAX_WAIT_MS : 0;
  return bool(v) ? MAX_WAIT_MS : 0;
}

export async function generateMockup(ctx, b, files = []) {
  requireScope(ctx, 'mockup');
  const input = await normalizeMockup(ctx, b, files);
  const { job, reused } = await submitJob(ctx, { type: 'mockup', input, meta: orderMeta(b), wait: waitMs(b, true) });
  return { ...(await jobView(job)), reused };
}

export async function batchMockups(ctx, b) {
  requireScope(ctx, 'mockup');
  const list = (v) => (Array.isArray(v) ? v : v === undefined || v === null || v === '' ? [] : String(v).split(',').map(x => x.trim()));
  const artworkIds = list(b.artwork_ids).length ? list(b.artwork_ids) : list(b.artwork_id);
  if (!artworkIds.length) throw bad('artwork_ids is required (analyze each artwork first).');
  const colors = list(b.garment_colors).length ? list(b.garment_colors) : [b.garment_color || 'Black'];
  const sizes = list(b.garment_sizes).length ? list(b.garment_sizes) : [b.garment_size || 'L'];
  const placements = list(b.placements).length ? list(b.placements) : [b.placement || 'front_center'];
  const total = artworkIds.length * colors.length * sizes.length * placements.length;
  if (total > 60) throw bad(`That is ${total} mockups; a batch can make at most 60.`);
  const mockups = [];
  for (const artwork_id of artworkIds) for (const garment_color of colors) for (const garment_size of sizes) for (const placement of placements) {
    mockups.push(await normalizeMockup(ctx, { ...b, artwork_id, garment_color, garment_size, placement, side: undefined, artwork_url: undefined, artwork_base64: undefined }));
  }
  const { job, reused } = await submitJob(ctx, { type: 'batch', input: { mockups }, meta: orderMeta(b), wait: waitMs(b, false) });
  return { ...(await jobView(job)), reused };
}

export async function mockupOptions(ctx) {
  requireScope(ctx, 'mockup');
  const garments = (await garmentLibrary()).map(publicGarment);
  return {
    sizes: SIZES,
    size_examples: ['Adult L', 'L', 'XXL', '2XL', 'Youth M', 'YM', '2T'],
    colors: COLORS,
    color_aliases: ['grey', 'gray', 'sport grey', 'heather grey', 'green', 'blue', 'royal', 'burgundy', 'purple', 'yellow', 'gold'],
    garment_types: [...new Set(garments.map(g => g.type).filter(Boolean))],
    garments,
    placements: Object.fromEntries(Object.keys(PLACEMENTS).map(name => [name, placementFor(name, 'L')])),
    placement_note: 'Positions are for size L (inches: center_x_in from the centre line, + = wearer\'s left; top_in from the top of the garment photo). Kids sizes scale down. Max sizes also never exceed the size chart\'s print limits.',
    output: { width_px: CANVAS_WIDTH, height_px: CANVAS_HEIGHT, format: 'png' },
  };
}

// ─── Gang sheets ─────────────────────────────────────────────────────────────
export async function createGangsheet(ctx, b, files = []) {
  requireScope(ctx, 'gangsheet');
  let items = jsonField(b.items, 'items');
  if (items === undefined && files.length) items = files.map(f => ({ upload: f, name: f.originalname }));
  if (!Array.isArray(items) || !items.length) throw bad('items is required: artwork_id or mockup_job_id (or an uploaded file / artwork_url), plus quantity and optional width_in / height_in.');
  if (items.length > 25) throw bad('At most 25 different artworks per gang sheet.');
  const filmWidth = num(b.film_width_in, 'film_width_in', { min: 10, max: 24, def: SHEET_WIDTH_INCHES });
  const margins = jsonField(b.margins, 'margins') || {};
  const input = {
    film_width_in: filmWidth,
    max_length_in: num(b.max_length_in, 'max_length_in', { min: 12, max: 200, def: MAX_SHEET_HEIGHT }),
    h_gap_in: num(b.h_gap_in, 'h_gap_in', { min: 0, max: 5, def: 0.5 }),
    v_gap_in: num(b.v_gap_in, 'v_gap_in', { min: 0, max: 5, def: 0.5 }),
    margins: {
      top: num(margins.top, 'margins.top', { min: 0, max: 5, def: 0 }), bottom: num(margins.bottom, 'margins.bottom', { min: 0, max: 5, def: 0 }),
      left: num(margins.left, 'margins.left', { min: 0, max: 5, def: 0 }), right: num(margins.right, 'margins.right', { min: 0, max: 5, def: 0 }),
    },
    header: {
      include: bool(b.include_header, true), top_margin_in: num(b.header_top_margin_in, 'header_top_margin_in', { min: 0, max: 5, def: 0 }),
      po_number: str(b.po_number, 40) || '', order_number: str(b.order_number, 40) || '', order_link: str(b.order_link, 500) || '',
    },
    items: [],
  };
  const usable = filmWidth - input.margins.left - input.margins.right;
  const warnings = [];
  let pieces = 0;
  for (const [i, raw] of items.entries()) {
    const it = raw || {};
    const label = `items[${i}]`;
    let art, mockupJobId = null, w0 = null, h0 = null;
    if (it.mockup_job_id) {
      const mj = await getJob(ctx, it.mockup_job_id);
      if (mj.type !== 'mockup' || mj.status !== 'ready') throw bad(`${label}: ${it.mockup_job_id} is not a finished mockup.`);
      art = await getArtwork({ ...ctx, isStaff: true }, mj.input.artwork_id);
      mockupJobId = mj.id; w0 = mj.result.final_print_width_in; h0 = mj.result.final_print_height_in;
      const cust = await statusOf('mockup', mj.id, 'customer');
      if (cust === 'rejected') throw bad(`${label}: the customer rejected mockup ${mj.id}.`, 'mockup_rejected');
      if (cust !== 'approved') warnings.push(w('ITEM_NOT_CUSTOMER_APPROVED', `${label}: mockup ${mj.id} is not customer-approved yet (${cust || 'agent review pending'}). QA will have to override.`));
    } else {
      art = await resolveArtworkRef(ctx, it.upload ? { upload: it.upload, name: it.name } : it, files, label);
      warnings.push(w('ITEM_NOT_FROM_MOCKUP', `${label}: artwork ${art.id} is not linked to a customer-approved mockup. QA will have to override.`));
    }
    if (art.format !== 'png') throw bad(`${label}: ${art.id} is a ${art.format.toUpperCase()} — gang sheets need PNG with a transparent background. Run /api/artworks/prepare first.`, 'unsupported_image');
    if (art.review_status === 'rejected') throw bad(`${label}: ${art.id} was rejected in review.`, 'artwork_rejected');
    if (art.review_status === 'pending_review') warnings.push(w('ITEM_ARTWORK_PENDING_REVIEW', `${label}: ${art.id} had its background removed and is not reviewed yet — QA cannot release the sheet until it is.`));
    if (art.analysis.background !== 'transparent') warnings.push(w('ITEM_NOT_TRANSPARENT', `${label}: ${art.id} has a ${art.analysis.background.replace('_', ' ')} background — it will print as a box.`));
    const aspect = art.width_px / art.height_px;
    let wIn = num(it.width_in, `${label}.width_in`, { min: 0.1, max: 24 });
    let hIn = num(it.height_in, `${label}.height_in`, { min: 0.1, max: 200 });
    if (mockupJobId && (wIn || hIn) && Math.abs((wIn || hIn * aspect) - w0) > 0.01) warnings.push(w('SIZE_DIFFERS_FROM_MOCKUP', `${label}: printing at ${wIn || +(hIn * aspect).toFixed(2)}" wide, but the approved mockup shows ${w0}".`));
    if (wIn && hIn && Math.abs(wIn / hIn - aspect) > 0.01) throw bad(`${label}: ${wIn}" × ${hIn}" does not match the artwork's ${art.analysis.ratio} ratio. Send only width_in or height_in.`, 'aspect_mismatch');
    if (wIn && !hIn) hIn = +(wIn / aspect).toFixed(2);
    else if (hIn && !wIn) wIn = +(hIn * aspect).toFixed(2);
    else if (!wIn && !hIn) { if (mockupJobId) { wIn = w0; hIn = h0; } else ({ w: wIn, h: hIn } = defaultItemSize(art.width_px, art.height_px, filmWidth)); }
    if (Math.min(wIn, hIn) > usable) throw bad(`${label} is ${wIn}" × ${hIn}" — it does not fit the ${usable}" usable film width even rotated.`);
    if (Math.max(wIn, hIn) > input.max_length_in && Math.min(wIn, hIn) > usable) throw bad(`${label} does not fit on a sheet.`);
    const dpi = Math.round(art.width_px / wIn);
    if (dpi < 150) warnings.push(w('ITEM_LOW_DPI', `${label}: ${dpi} DPI at ${wIn}" wide — it will print soft.`));
    const quantity = num(it.quantity, `${label}.quantity`, { min: 1, max: 500, def: 1 });
    if (!Number.isInteger(quantity)) throw bad(`${label}.quantity must be a whole number.`);
    pieces += quantity;
    input.items.push({ artwork_id: art.id, mockup_job_id: mockupJobId, name: str(it.name, 80) || art.name || `Artwork ${i + 1}`, width_in: wIn, height_in: hIn, quantity });
  }
  if (pieces > 500) throw bad(`At most 500 pieces per gang sheet job (got ${pieces}).`);
  if (input.header.include && filmWidth < 11) { input.header.include = false; warnings.push(w('HEADER_OMITTED', 'Film narrower than 11" has no room for the order header.')); }
  const { job, reused } = await submitJob(ctx, { type: 'gangsheet', input, meta: orderMeta(b), warnings, wait: waitMs(b, false) });
  return { ...(await jobView(job)), reused };
}

// ─── Jobs, exports, approvals ────────────────────────────────────────────────
export async function jobStatus(ctx, id) {
  return jobView(await getJob(ctx, id));
}

export async function jobsList(ctx, b) {
  const rows = await listJobs(ctx, { order_id: str(b.order_id), type: str(b.type, 20), status: str(b.status, 20), limit: b.limit });
  return { jobs: await Promise.all(rows.map(r => jobView(r, { brief: true }))) };
}

export async function exportPackage(ctx, b) {
  requireScope(ctx, 'export');
  const outputType = str(b.output_type, 30) || 'customer_preview';
  if (!['customer_preview', 'production'].includes(outputType)) throw bad('output_type must be customer_preview or production.');
  let jobs;
  const ids = Array.isArray(b.job_ids) ? b.job_ids : b.job_ids ? String(b.job_ids).split(',').map(s => s.trim()) : [];
  if (ids.length) jobs = await Promise.all(ids.slice(0, 200).map(id => getJob(ctx, id)));
  else if (b.order_id) {
    const params = [String(b.order_id)];
    let owner = '';
    if (!ctx.isStaff) { params.push(ctx.appId); owner = 'AND app_id = $2'; }
    jobs = (await q(`SELECT * FROM api_jobs WHERE order_id = $1 ${owner} AND type IN ('mockup','gangsheet') ORDER BY created_at`, params)).rows;
  } else throw bad('Send order_id or job_ids.');
  if (!jobs.length) throw new ApiError(404, 'nothing_found', 'No jobs found for that order.');
  const { include, skipped } = await exportable(jobs, outputType);
  if (!include.length) throw new ApiError(409, 'approval_required', outputType === 'customer_preview'
    ? 'No mockup here is approved by an agent yet — a person must approve mockups before they go to the customer.'
    : 'No gang sheet here is QA-approved yet.', { skipped });
  const skippedWarnings = skipped.map(x => w('SKIPPED', `${x.job_id}: ${x.reason}`));
  const { job } = await submitJob(ctx, { type: 'export', input: { output_type: outputType, job_ids: include.map(j => j.id), skipped }, meta: orderMeta(b), warnings: skippedWarnings, dedupe: false, wait: waitMs(b, true) });
  return jobView(job);
}

export async function approvals(ctx, b) {
  requireScope(ctx, 'approve');
  const out = await listApprovals(ctx, { status: str(b.status, 20) || 'pending', order_id: str(b.order_id), limit: b.limit });
  if (b.include === 'subjects') {
    // One request for the whole queue: each approval with what it is about.
    const cache = new Map();
    const load = async (type, id) => {
      const key = `${type}:${id}`;
      if (!cache.has(key)) cache.set(key, (async () => {
        try {
          if (type === 'artwork') {
            const row = await getArtwork(ctx, id);
            const view = await artworkView(row);
            if (row.parent_artwork_id) { try { view.parent = await artworkView(await getArtwork({ ...ctx, isStaff: true }, row.parent_artwork_id)); } catch { view.parent = null; } }
            return view;
          }
          return await jobView(await getJob(ctx, id));
        } catch { return null; }
      })());
      return cache.get(key);
    };
    out.approvals = await Promise.all(out.approvals.map(async a => ({ ...a, subject: await load(a.subject_type, a.subject_id) })));
  }
  return out;
}

export async function decideApproval(ctx, id, b) {
  requireScope(ctx, 'approve');
  return decide(ctx, id, b);
}

export { one };
