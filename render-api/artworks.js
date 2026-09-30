// Artwork records: analysis (pure pixel maths — never AI vision) and preparation
// (background removal with the studio's own Artwork Editor functions, trim,
// resample, DPI). Every prepared artwork is a new record pointing at its parent;
// the original is never overwritten.
import crypto from 'node:crypto';
import { createCanvas } from '@napi-rs/canvas';
import { removeBackground, removeBackgroundFast, removeBackgroundBalanced, removeBackgroundAI, detectArtworkType } from '../src/utils/bgRemovalUtils.js';
import { ApiError, bad, withDpi } from './common.js';
import { sniffImage, decodeImage, MAX_IMAGE_PIXELS } from './inputs.js';
import { q, one, newId } from './db.js';
import { saveFile, fileRow, readFile, signedUrl } from './storage.js';
import { createApproval, approvalsFor } from './approvals.js';

const PRINT_DPI = 300;
const w = (code, message) => ({ code, message });

// ─── Metadata ────────────────────────────────────────────────────────────────
function readDpi(buf, type) {
  if (type === 'png') {
    let i = 8;
    while (i + 12 <= buf.length) {
      const len = buf.readUInt32BE(i);
      const kind = buf.toString('ascii', i + 4, i + 8);
      if (kind === 'pHYs' && len === 9) {
        const x = buf.readUInt32BE(i + 8), y = buf.readUInt32BE(i + 12), unit = buf[i + 16];
        if (unit === 1) return { x: +(x * 0.0254).toFixed(1), y: +(y * 0.0254).toFixed(1), source: 'png_phys' };
        return { x: null, y: null, source: 'png_phys_no_unit' };
      }
      if (kind === 'IDAT' || kind === 'IEND') break;
      i += 12 + len;
    }
  } else {
    let i = 2;
    while (i + 16 < buf.length && buf[i] === 0xff) {
      const marker = buf[i + 1], len = buf.readUInt16BE(i + 2);
      if (marker === 0xe0 && buf.toString('ascii', i + 4, i + 8) === 'JFIF') {
        const units = buf[i + 11], x = buf.readUInt16BE(i + 12), y = buf.readUInt16BE(i + 14);
        if (units === 1) return { x, y, source: 'jpeg_jfif' };
        if (units === 2) return { x: +(x * 2.54).toFixed(1), y: +(y * 2.54).toFixed(1), source: 'jpeg_jfif' };
        return { x: null, y: null, source: 'jpeg_jfif_no_unit' };
      }
      if (marker === 0xda) break;
      i += 2 + len;
    }
  }
  return { x: null, y: null, source: 'none' };
}

function pixels(image) {
  const c = createCanvas(image.width, image.height);
  const ctx = c.getContext('2d');
  ctx.drawImage(image, 0, 0);
  return ctx.getImageData(0, 0, image.width, image.height);
}

const quant = (v) => Math.round(v / 4) * 4;
const neutral = ([r, g, b]) => Math.max(r, g, b) - Math.min(r, g, b) < 14;

/** Edge pixels decide what the "background" is. */
function classifyBackground(img) {
  const { data, width, height } = img;
  const step = Math.max(1, Math.floor(Math.max(width, height) / 1500));
  const edge = [];
  const push = (x, y) => edge.push((y * width + x) * 4);
  for (let x = 0; x < width; x += step) { push(x, 0); push(x, height - 1); }
  for (let y = 0; y < height; y += step) { push(0, y); push(width - 1, y); }
  let transparent = 0;
  const counts = new Map();
  for (const o of edge) {
    if (data[o + 3] < 10) { transparent++; continue; }
    const key = `${quant(data[o])},${quant(data[o + 1])},${quant(data[o + 2])}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  // A quarter of the border truly transparent means a transparent background: a
  // design trimmed tight (or bleeding off one side) touches the other edges.
  if (transparent / edge.length >= 0.25) return { type: 'transparent', colors: [] };
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const opaque = edge.length - transparent;
  const [c1, n1] = sorted[0] || ['0,0,0', 0];
  const [c2, n2] = sorted[1] || ['0,0,0', 0];
  const rgb1 = c1.split(',').map(Number), rgb2 = c2.split(',').map(Number);

  // Checkerboard "fake transparency": two light neutral tones alternating in blocks.
  if (n1 + n2 >= opaque * 0.85 && n2 >= opaque * 0.2 && neutral(rgb1) && neutral(rgb2) && Math.min(rgb1[0], rgb2[0]) > 150
      && Math.abs(rgb1[0] - rgb2[0]) >= 8) {
    let flips = 0, prev = null;
    for (let x = 0; x < width; x += step) {
      const o = x * 4;
      const key = `${quant(data[o])},${quant(data[o + 1])},${quant(data[o + 2])}`;
      if (key !== c1 && key !== c2) continue;
      if (prev && key !== prev) flips++;
      prev = key;
    }
    if (flips >= 6) return { type: 'checkerboard', colors: [rgb1, rgb2] };
  }
  if (n1 >= opaque * 0.7) {
    const isWhite = rgb1.every(v => v >= 236);
    return { type: isWhite ? 'white' : 'solid_color', colors: [rgb1] };
  }
  return { type: 'complex', colors: [] };
}

function contentBounds(img, bg) {
  const { data, width, height } = img;
  let minX = width, minY = height, maxX = -1, maxY = -1;
  const isBg = (o) => {
    if (data[o + 3] <= 8) return true;
    return bg.colors.some(c => Math.abs(data[o] - c[0]) + Math.abs(data[o + 1] - c[1]) + Math.abs(data[o + 2] - c[2]) < 40);
  };
  if (bg.type === 'complex') return { x: 0, y: 0, width, height };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (isBg((y * width + x) * 4)) continue;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

const gcd = (a, b) => (b ? gcd(b, a % b) : a);

export function analyzePixels(buf, image) {
  const info = sniffImage(buf);
  const img = pixels(image);
  const { data, width, height } = img;
  let alpha0 = 0, alphaFull = 0, visible = 0, semi = 0;
  for (let i = 3; i < data.length; i += 4) {
    const a = data[i];
    if (a === 0) alpha0++;
    else if (a === 255) alphaFull++;
    if (a > 8) { visible++; if (a < 247) semi++; }
  }
  const total = width * height;
  const hasAlphaChannel = info.type === 'png' && [4, 6].includes(buf[25]) || (info.type === 'png' && buf.includes(Buffer.from('tRNS')));
  const bg = classifyBackground(img);
  const bounds = contentBounds(img, bg);
  const dpi = readDpi(buf, info.type);

  let alphaStatus;
  if (!hasAlphaChannel) alphaStatus = 'no_alpha';
  else if (alpha0 === 0) alphaStatus = 'alpha_all_opaque';
  else if (bg.type === 'transparent') alphaStatus = 'transparent_background';
  else alphaStatus = 'alpha_present_background_opaque';

  const warnings = [];
  if (bg.type === 'white') warnings.push(w('WHITE_BACKGROUND', 'The background is solid white, not transparent — it would print as a white box on DTF.'));
  else if (bg.type === 'solid_color') warnings.push(w('SOLID_BACKGROUND', `The background is a solid colour (rgb ${bg.colors[0].join(',')}), not transparent.`));
  else if (bg.type === 'checkerboard') warnings.push(w('FAKE_CHECKERBOARD_BACKGROUND', 'The grey/white checkerboard is baked into the pixels — it is not real transparency and would print.'));
  else if (bg.type === 'complex') warnings.push(w('NO_TRANSPARENT_BACKGROUND', 'The edges are opaque and not a single colour (photo or full-bleed design). Background cannot be removed automatically with confidence.'));
  if (visible > 0 && semi / visible > 0.05) warnings.push(w('SEMI_TRANSPARENT_PIXELS', `${(100 * semi / visible).toFixed(1)}% of visible pixels are partly transparent — soft shadows/glows print unevenly on DTF.`));
  if (bounds) {
    const pad = { top: bounds.y, left: bounds.x, right: width - bounds.x - bounds.width, bottom: height - bounds.y - bounds.height };
    if (Math.max(pad.left + pad.right) > width * 0.1 || pad.top + pad.bottom > height * 0.1) {
      warnings.push(w('EXCESS_PADDING', `Empty margin around the design (${pad.top}/${pad.right}/${pad.bottom}/${pad.left} px) makes the printed size larger than the visible design. Trim it (prepare with trim=true).`));
    }
  } else warnings.push(w('EMPTY_IMAGE', 'No visible content was found.'));
  const sharpWidth = +(width / PRINT_DPI).toFixed(2);
  if (sharpWidth < 10) warnings.push(w('LOW_RESOLUTION', `At 300 DPI this artwork is only ${sharpWidth}" wide; a 10" print would be ${Math.round(width / 10)} DPI.`));
  if (Math.min(width, height) < 500) warnings.push(w('TINY_IMAGE', `Only ${width}×${height} px.`));

  const g = gcd(width, height);
  const type = detectArtworkType(img);
  return {
    format: info.type,
    width_px: width,
    height_px: height,
    aspect_ratio: +(width / height).toFixed(4),
    ratio: `${width / g}:${height / g}`,
    alpha_status: alphaStatus,
    background: bg.type,
    background_colors: bg.colors.map(c => `#${c.map(v => Math.min(255, v).toString(16).padStart(2, '0')).join('')}`),
    transparent_pixel_ratio: +(alpha0 / total).toFixed(4),
    semi_transparent_ratio: visible ? +(semi / visible).toFixed(4) : 0,
    content_bounds_px: bounds,
    content_aspect_ratio: bounds ? +(bounds.width / bounds.height).toFixed(4) : null,
    dpi,
    print_size_at_300dpi_in: { width: sharpWidth, height: +(height / PRINT_DPI).toFixed(2) },
    max_print_width_in: { at_300dpi: sharpWidth, at_150dpi: +(width / 150).toFixed(2) },
    artwork_type: type.type,
    recommended_prep: {
      remove_background: bg.type === 'checkerboard' ? 'checkerboard' : ['white', 'solid_color'].includes(bg.type) ? 'auto' : 'none',
      trim: warnings.some(x => x.code === 'EXCESS_PADDING'),
    },
    warnings,
  };
}

// ─── Records ─────────────────────────────────────────────────────────────────
export async function artworkView(row, { withUrl = true } = {}) {
  const approvals = await approvalsFor('artwork', row.id);
  return {
    artwork_id: row.id,
    name: row.name,
    ...row.analysis,
    file_bytes: Number(row.bytes),
    sha256: row.sha256,
    parent_artwork_id: row.parent_artwork_id,
    prep: row.prep,
    review_status: row.review_status,
    approvals,
    order_id: row.order_id, customer_id: row.customer_id, lead_id: row.lead_id,
    requested_by: row.requested_by,
    created_at: row.created_at,
    file_url: withUrl ? signedUrl(row.file_id) : undefined,
  };
}

/** Load an artwork the caller may use; staff (studio sessions) may use any. */
export async function getArtwork(ctx, id) {
  if (!/^ART_[0-9A-Z]{12}$/.test(String(id || ''))) throw bad(`"${id}" is not an artwork_id (ART_…).`, 'unknown_artwork');
  const row = await one('SELECT * FROM api_artworks WHERE id = $1', [id]);
  if (!row || (!ctx.isStaff && Number(row.app_id) !== ctx.appId)) throw new ApiError(404, 'unknown_artwork', `Artwork ${id} not found.`);
  return row;
}

export async function artworkImage(row) {
  const f = await fileRow(row.file_id);
  if (!f) throw new ApiError(410, 'artwork_expired', `The file for ${row.id} is past its retention period. Upload it again.`);
  const buf = await readFile(f);
  return { buf, image: await decodeImage(buf, row.id) };
}

/** Store (or find the identical, already stored) artwork and analyse it. */
export async function ingestArtwork(ctx, buf, meta = {}) {
  const image = await decodeImage(buf, meta.label || 'artwork');
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  const existing = await one(
    `SELECT a.* FROM api_artworks a JOIN api_files f ON f.id = a.file_id
     WHERE COALESCE(a.app_id, 0) = $1 AND a.sha256 = $2 AND a.parent_artwork_id IS NULL ORDER BY a.created_at LIMIT 1`,
    [ctx.appId || 0, sha256]);
  if (existing && !meta.parentId) return { row: existing, reused: true, image };

  const analysis = analyzePixels(buf, image);
  const id = newId('ART');
  const ext = analysis.format === 'png' ? '.png' : '.jpg';
  const fileId = await saveFile({ ownerType: 'artwork', ownerId: id, kind: 'artwork', buffer: buf,
    fileName: `${id}${ext}`, contentType: analysis.format === 'png' ? 'image/png' : 'image/jpeg' });
  const row = await one(`INSERT INTO api_artworks (id, app_id, user_id, name, file_id, format, bytes, sha256, width_px, height_px,
      analysis, parent_artwork_id, prep, review_status, order_id, customer_id, lead_id, requested_by, via)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *`,
  [id, ctx.appId, ctx.userId, (meta.name || '').slice(0, 200), fileId, analysis.format, buf.length, sha256, analysis.width_px, analysis.height_px,
    analysis, meta.parentId || null, meta.prep || null, meta.reviewStatus || 'not_required',
    meta.order_id || null, meta.customer_id || null, meta.lead_id || null, ctx.requestedBy, ctx.via]);
  return { row, reused: false, image };
}

// ─── Preparation ─────────────────────────────────────────────────────────────
const BG_MODES = ['none', 'auto', 'white', 'solid', 'checkerboard', 'fast', 'balanced', 'precision'];

function removeCheckerboard(img, colors) {
  // Flood-fill from the edges through pixels matching either checker tone.
  const { data, width, height } = img;
  const out = new Uint8ClampedArray(data);
  const match = (o) => out[o + 3] > 8 && colors.some(c => Math.abs(out[o] - c[0]) + Math.abs(out[o + 1] - c[1]) + Math.abs(out[o + 2] - c[2]) < 24);
  const seen = new Uint8Array(width * height);
  const stack = [];
  const seed = (x, y) => { const p = y * width + x; if (!seen[p] && match(p * 4)) { seen[p] = 1; stack.push(p); } };
  for (let x = 0; x < width; x++) { seed(x, 0); seed(x, height - 1); }
  for (let y = 0; y < height; y++) { seed(0, y); seed(width - 1, y); }
  while (stack.length) {
    const p = stack.pop();
    out[p * 4 + 3] = 0;
    const x = p % width, y = (p - x) / width;
    if (x > 0) seed(x - 1, y); if (x < width - 1) seed(x + 1, y);
    if (y > 0) seed(x, y - 1); if (y < height - 1) seed(x, y + 1);
  }
  return new ImageData(out, width, height);
}

function trimToContent(img) {
  const { data, width, height } = img;
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (data[(y * width + x) * 4 + 3] <= 8) continue;
    if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  if (maxX < 0) throw bad('Nothing visible is left after background removal — the artwork would be empty.', 'empty_result');
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

export async function prepareArtwork(ctx, source, opts, meta = {}) {
  const mode = opts.remove_background || 'none';
  if (!BG_MODES.includes(mode)) throw bad(`remove_background must be one of: ${BG_MODES.join(', ')}.`);
  const { buf, image } = await artworkImage(source);
  let img = pixels(image);
  const steps = [];
  const warnings = [];
  const before = source.analysis;
  let removed = false;

  let effective = mode;
  if (mode === 'auto') {
    effective = { checkerboard: 'checkerboard', white: 'white', solid_color: 'solid' }[before.background] || 'none';
    if (before.background === 'complex') warnings.push(w('BACKGROUND_NOT_REMOVED', 'The background is too complex to remove automatically — use the Artwork Editor, or pick a mode (fast / balanced / precision) and review the result.'));
  }
  if (effective !== 'none') {
    if (before.background === 'transparent' && ['white', 'solid', 'checkerboard'].includes(effective)) {
      warnings.push(w('ALREADY_TRANSPARENT', 'The background is already transparent; nothing was removed.'));
    } else {
      const opaqueBefore = countOpaque(img);
      if (effective === 'checkerboard') {
        const bg = classifyBackground(img);
        if (bg.type !== 'checkerboard') throw bad('No checkerboard background was detected on this artwork.', 'not_checkerboard');
        img = removeCheckerboard(img, bg.colors);
      } else if (effective === 'white' || effective === 'solid') {
        img = removeBackground(img, 30, 0, false); // edge-connected only — white inside the design stays
      } else if (effective === 'fast') img = removeBackgroundFast(img);
      else if (effective === 'balanced') img = removeBackgroundBalanced(img);
      else if (effective === 'precision') img = removeBackgroundAI(img);
      const removedRatio = 1 - countOpaque(img) / Math.max(1, opaqueBefore);
      steps.push({ step: 'remove_background', mode: effective, removed_pixel_ratio: +removedRatio.toFixed(4) });
      removed = removedRatio > 0;
      if (['fast', 'balanced', 'precision'].includes(effective)) warnings.push(w('INTERIOR_WHITE_REMOVED', `The "${effective}" mode also removes enclosed white/light areas inside the design. Check the result before using it.`));
    }
  }

  let canvas = createCanvas(img.width, img.height);
  canvas.getContext('2d').putImageData(img, 0, 0);
  if (opts.trim !== false) {
    const b = trimToContent(img);
    if (b.width !== img.width || b.height !== img.height) {
      const c = createCanvas(b.width, b.height);
      c.getContext('2d').drawImage(canvas, b.x, b.y, b.width, b.height, 0, 0, b.width, b.height);
      canvas = c;
      steps.push({ step: 'trim', from_px: [img.width, img.height], to_px: [b.width, b.height] });
    }
  }
  const dpi = opts.target_dpi || 300;
  if (opts.target_print_width_in) {
    const targetW = Math.round(opts.target_print_width_in * dpi);
    const targetH = Math.round(targetW * canvas.height / canvas.width);
    if (targetW * targetH > MAX_IMAGE_PIXELS) throw bad(`${opts.target_print_width_in}" at ${dpi} DPI would be ${targetW}×${targetH} px, over the 64-megapixel limit.`);
    if (targetW > canvas.width) warnings.push(w('UPSCALED', `Enlarged from ${canvas.width} to ${targetW} px wide — upscaling adds pixels, not detail.`));
    const c = createCanvas(targetW, targetH);
    const cx = c.getContext('2d');
    cx.imageSmoothingEnabled = true; cx.imageSmoothingQuality = 'high';
    cx.drawImage(canvas, 0, 0, targetW, targetH);
    steps.push({ step: 'resample', to_px: [targetW, targetH], print_width_in: opts.target_print_width_in, dpi });
    canvas = c;
  }
  const out = withDpi(await canvas.encode('png'), dpi);
  steps.push({ step: 'png', dpi });

  const reviewStatus = removed ? 'pending_review' : 'not_required';
  const { row } = await ingestArtwork(ctx, out, {
    name: source.name ? `${source.name} (prepared)` : '', parentId: source.id, prep: { steps, requested: opts }, reviewStatus,
    order_id: meta.order_id || source.order_id, customer_id: meta.customer_id || source.customer_id, lead_id: meta.lead_id || source.lead_id,
  });
  if (removed) await createApproval({ subjectType: 'artwork', subjectId: row.id, stage: 'artwork_review', orderId: row.order_id });
  return { row, warnings };
}

function countOpaque(img) {
  let n = 0;
  for (let i = 3; i < img.data.length; i += 4) if (img.data[i] > 8) n++;
  return n;
}
