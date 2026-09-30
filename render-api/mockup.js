// Mockup renderer — the server-side twin of DesignCanvas.drawScene({ guides: false }),
// which is what "Save MU" stores. Same canvas size, same garment scaling and the
// same tint engine; artwork is placed by inches from named placements.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { TSHIRT_SIZES, TSHIRT_COLORS, SIZE_ORDER } from '../src/constants/tshirtSizes.js';
import { recolorGarment } from '../src/utils/garmentTintEngine.js';

const CANVAS_SCALE = 4;
export const CANVAS_WIDTH = 700 * CANVAS_SCALE;
export const CANVAS_HEIGHT = 850 * CANVAS_SCALE;
const KIDS_SIZES = ['2T', '3T', '4T', '5T', 'YS', 'YM', 'YL', 'YXL'];
const GARMENT_DIR = process.env.GARMENT_DIR || '/garment-data';

// ─── Garment library (same garments.json the Garment Manager writes) ─────────
let libraryCache = { at: 0, list: [] };
export async function garmentLibrary() {
  if (Date.now() - libraryCache.at < 60_000) return libraryCache.list;
  try {
    const list = JSON.parse(await fs.readFile(path.join(GARMENT_DIR, 'garments.json'), 'utf8'));
    libraryCache = { at: Date.now(), list: Array.isArray(list) ? list.filter(g => g.imageFile) : [] };
  } catch (e) {
    console.error('[garments] cannot read library:', e.message);
  }
  return libraryCache.list;
}

export function publicGarment(g) {
  return {
    id: g.id, name: g.name, type: g.type, fit: g.gender || g.fit || null, size: g.size,
    side: g.side || 'front', brand: g.brand || null, style_no: g.styleNo || null,
  };
}

// A 10000px garment PNG decodes to ~350 MB, so only the scaled copy is cached.
const scaledGarments = new Map();
async function scaledGarment(g, w, h) {
  const key = `${g.id}:${w}x${h}`;
  if (scaledGarments.has(key)) {
    const hit = scaledGarments.get(key);
    scaledGarments.delete(key); scaledGarments.set(key, hit);
    return hit;
  }
  const src = await loadImage(await fs.readFile(path.join(GARMENT_DIR, path.basename(g.imageFile))));
  const c = createCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, w, h);
  scaledGarments.set(key, c);
  while (scaledGarments.size > 24) scaledGarments.delete(scaledGarments.keys().next().value);
  return c;
}

// garmentTintEngine.drawRecoloredGarment, with the garment already scaled.
async function drawRecoloredGarment(ctx, garment, dx, dy, dw, dh, colorHex) {
  const w = Math.floor(dw), h = Math.floor(dh);
  if (w < 1 || h < 1) return;
  const scaled = await scaledGarment(garment, w, h);
  const hex = colorHex.replace('#', '');
  const r = parseInt(hex.substring(0, 2), 16), g = parseInt(hex.substring(2, 4), 16), b = parseInt(hex.substring(4, 6), 16);
  if (r > 240 && g > 240 && b > 240) { ctx.drawImage(scaled, dx, dy, dw, dh); return; }
  const temp = createCanvas(w, h);
  const tctx = temp.getContext('2d');
  tctx.drawImage(scaled, 0, 0);
  tctx.putImageData(recolorGarment(tctx.getImageData(0, 0, w, h), colorHex), 0, 0);
  ctx.drawImage(temp, dx, dy);
}


// ─── Garment resolution ──────────────────────────────────────────────────────
const w = (code, message) => ({ code, message });
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// Extra colour names beyond the studio palette.
const COLOR_ALIASES = {
  grey: '#9ea2a2', gray: '#9ea2a2', 'sport grey': '#9ea2a2', 'sport gray': '#9ea2a2', 'heather grey': '#9ea2a2', 'heather gray': '#9ea2a2',
  'dark gray': '#5a5a5a', green: '#2d5a3a', blue: '#2563eb', 'royal': '#2563eb', burgundy: '#6b1d2e', purple: '#5b2a86', yellow: '#facc15', 'gold': '#d4a017',
};

export function resolveColor(input) {
  if (!input) return TSHIRT_COLORS[0];
  const s = String(input).trim();
  const named = TSHIRT_COLORS.find(c => norm(c.name) === norm(s));
  if (named) return named;
  if (COLOR_ALIASES[norm(s)]) return { name: s.replace(/\b\w/g, ch => ch.toUpperCase()), hex: COLOR_ALIASES[norm(s)] };
  const m = s.match(/^#?([0-9a-f]{6}|[0-9a-f]{3})$/i);
  if (!m) return null;
  const hex = m[1].length === 3 ? m[1].split('').map(ch => ch + ch).join('') : m[1];
  return { name: `#${hex.toLowerCase()}`, hex: `#${hex.toLowerCase()}` };
}

/** "Adult L" → L, "Youth M" → YM, "Toddler 2T" → 2T, "XXL" → 2XL. Also returns a fit hint. */
export function resolveSize(input) {
  if (!input) return { size: 'L', fit: null };
  let s = String(input).trim().toUpperCase().replace(/[^A-Z0-9 ]/g, ' ');
  let fit = null;
  if (/\b(LADIES|LADY|WOMEN|WOMENS|WOMAN)\b/.test(s)) fit = 'Women';
  if (/\b(MEN|MENS)\b/.test(s)) fit = 'Men';
  const youth = /\b(YOUTH|KIDS|KID|BOYS|GIRLS)\b/.test(s);
  s = s.replace(/\b(ADULT|UNISEX|LADIES|LADY|WOMENS|WOMEN|WOMAN|MENS|MEN|YOUTH|KIDS|KID|BOYS|GIRLS|TODDLER|SIZE)\b/g, ' ').replace(/\s+/g, '').trim();
  s = s.replace(/^XXXXXL$/, '5XL').replace(/^XXXXL$/, '4XL').replace(/^XXXL$/, '3XL').replace(/^XXL$/, '2XL')
    .replace(/^SMALL$/, 'S').replace(/^MEDIUM$/, 'M').replace(/^LARGE$/, 'L');
  if (youth) { fit = 'Kids'; if (['XS', 'S', 'M', 'L', 'XL'].includes(s)) s = s === 'XS' ? 'YS' : `Y${s}`; }
  if (KIDS_SIZES.includes(s)) fit = 'Kids';
  return TSHIRT_SIZES[s] ? { size: s, fit } : { size: null, fit };
}

const matchesFit = (g, fit) => {
  if (!fit) return true;
  const gFit = (g.gender || g.fit || 'Men').toLowerCase();
  const f = fit.toLowerCase();
  if (f === 'kids') return gFit === 'kids' || KIDS_SIZES.includes(g.size);
  return gFit === f || gFit === 'all' || gFit === 'unisex';
};

/**
 * Pick the garment photo for style/type + size + side. A photo of another size or
 * side would misstate the scale or collar, so none is substituted: the vector shirt
 * (sized from the size chart) is used instead, with a warning.
 */
export function resolveGarment(list, { garment_id, garment_style, garment_type, fit, size, side }) {
  const warnings = [];
  if (garment_id) {
    const g = list.find(x => x.id === garment_id);
    if (!g) throw Object.assign(new Error(`No garment with id "${garment_id}". See /api/mockups/options.`), { code: 'unknown_garment' });
    if (g.size !== size) warnings.push(w('GARMENT_SIZE_DIFFERS', `garment_id ${g.id} is a ${g.size} photo but size ${size} was requested; the photo is drawn at its own size.`));
    if ((g.side || 'front') !== side) warnings.push(w('GARMENT_SIDE_DIFFERS', `garment_id ${g.id} is a ${g.side || 'front'} photo but side ${side} was requested.`));
    return { garment: g, warnings, style_matched: true };
  }
  let pool = list;
  let styleMatched = false;
  if (garment_style) {
    const st = norm(garment_style);
    const tokens = st.split(' ').filter(Boolean);
    const byStyle = list.filter(g => {
      const hay = norm(`${g.brand} ${g.styleNo} ${g.name} ${g.description}`);
      return (g.styleNo && tokens.includes(norm(g.styleNo))) || tokens.every(t => hay.includes(t));
    });
    const byType = list.filter(g => norm(g.type) === st);
    if (byStyle.length) { pool = byStyle; styleMatched = true; }
    else if (byType.length) { pool = byType; styleMatched = true; }
    else warnings.push(w('GARMENT_STYLE_NOT_IN_LIBRARY', `No garment photo is tagged "${garment_style}" in the Garment Manager; using the ${garment_type || 'T-Shirt'} photos.`));
  }
  if (!styleMatched) pool = list.filter(g => norm(g.type) === norm(garment_type || 'T-Shirt'));
  const exact = pool.filter(g => g.size === size && (g.side || 'front') === side);
  const g = exact.find(x => matchesFit(x, fit)) || exact[0] || null;
  if (!g) {
    const otherSide = pool.some(x => x.size === size);
    warnings.push(w('NO_GARMENT_PHOTO', otherSide
      ? `There is no ${side} photo for size ${size}; a plain ${side} shirt drawn from the size chart is used instead.`
      : `There is no garment photo for size ${size}; a plain shirt drawn from the size chart is used instead.`));
  }
  return { garment: g, warnings, style_matched: styleMatched };
}

// ─── Placements ──────────────────────────────────────────────────────────────
// Positions are measured on the garment photo: center_x_in from the centre line
// (positive = wearer's left, the viewer's right), top_in from the top of the
// photo. front_center / back_center use the studio's default print top (7").
export const PLACEMENTS = {
  front_center: { side: 'front', center_x_in: 0, top_in: 7, default_width_in: 11, max_width_in: null, max_height_in: null, label: 'Front center' },
  left_chest: { side: 'front', center_x_in: 4, top_in: 7.5, default_width_in: 3.75, max_width_in: 5, max_height_in: 5, label: 'Left chest' },
  right_chest: { side: 'front', center_x_in: -4, top_in: 7.5, default_width_in: 3.75, max_width_in: 5, max_height_in: 5, label: 'Right chest' },
  pocket: { side: 'front', center_x_in: 4, top_in: 7.5, default_width_in: 3.5, max_width_in: 4.5, max_height_in: 4.5, label: 'Pocket' },
  back_center: { side: 'back', center_x_in: 0, top_in: 6, default_width_in: 12, max_width_in: null, max_height_in: null, label: 'Back center' },
  back_neck: { side: 'back', center_x_in: 0, top_in: 4, default_width_in: 3, max_width_in: 4, max_height_in: 3, label: 'Back neck' },
  custom: { side: null, center_x_in: 0, top_in: 7, default_width_in: 10, max_width_in: null, max_height_in: null, label: 'Custom' },
};

/** Placement geometry for a size; kids sizes scale positions by body width. */
export function placementFor(name, size, overrides = {}) {
  const p = PLACEMENTS[name];
  if (!p) return null;
  const sz = TSHIRT_SIZES[size];
  const k = KIDS_SIZES.includes(size) ? sz.bodyWidth / 22 : 1;
  const r2 = (v) => +v.toFixed(2);
  return {
    name, label: p.label,
    side: overrides.side || p.side || 'front',
    center_x_in: r2(overrides.custom_x_in ?? p.center_x_in * k),
    top_in: r2(overrides.custom_y_in ?? p.top_in * k),
    default_width_in: r2(p.default_width_in * k),
    max_width_in: r2(overrides.max_width_in ?? Math.min(p.max_width_in ? p.max_width_in * k : sz.maxPrintWidth, sz.maxPrintWidth)),
    max_height_in: r2(overrides.max_height_in ?? Math.min(p.max_height_in ? p.max_height_in * k : sz.maxPrintHeight, sz.maxPrintHeight)),
  };
}

/** Final print size. Aspect ratio is always preserved; sizes only ever shrink to fit. */
export function printSize(aspect, placement, { width_in, height_in }) {
  const warnings = [];
  let wIn, status;
  if (width_in) { wIn = width_in; status = 'requested_width_used'; }
  else if (height_in) { wIn = height_in * aspect; status = 'requested_height_used'; }
  else { wIn = placement.default_width_in; status = 'default_width_used'; }
  let hIn = wIn / aspect;
  if (wIn > placement.max_width_in + 1e-9) {
    warnings.push(w('PRINT_WIDTH_REDUCED', `${(+wIn.toFixed(2))}" is wider than the ${placement.max_width_in}" maximum for ${placement.label.toLowerCase()} on this size; reduced to ${placement.max_width_in}".`));
    wIn = placement.max_width_in; hIn = wIn / aspect; status = 'reduced_to_max_width';
  }
  if (hIn > placement.max_height_in + 1e-9) {
    warnings.push(w('PRINT_HEIGHT_REDUCED', `At that width the print would be ${hIn.toFixed(2)}" tall, over the ${placement.max_height_in}" maximum; reduced to ${placement.max_height_in}" tall.`));
    hIn = placement.max_height_in; wIn = hIn * aspect; status = 'reduced_to_max_height';
  }
  return { width_in: +wIn.toFixed(2), height_in: +hIn.toFixed(2), scale_status: status, warnings };
}

const SCALE_TEXT = {
  requested_width_used: 'requested width used', requested_height_used: 'requested height used', default_width_used: 'default width used',
  reduced_to_max_width: 'reduced to max width', reduced_to_max_height: 'reduced to max height',
};

// ─── Render ──────────────────────────────────────────────────────────────────
/**
 * Same geometry as DesignCanvas: garment drawn at its real inches on a fixed
 * 2800×3400 stage, artwork at its print size in inches on top. `label` adds the
 * order/size strip along the bottom.
 */
export async function renderMockup({ artwork, size, color, side, garment, placement, print, background, label }) {
  const canvas = createCanvas(CANVAS_WIDTH, CANVAS_HEIGHT);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  if (background && background !== 'transparent') { ctx.fillStyle = background; ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT); }

  const sizeData = TSHIRT_SIZES[size];
  const maxTshirtW = CANVAS_WIDTH * 0.52, maxTshirtH = CANVAS_HEIGHT * 0.68;
  const pxPerInchW = maxTshirtW / 32, pxPerInchH = maxTshirtH / 35;
  const ppi = Math.min(pxPerInchW, pxPerInchH);
  let tshirtW, tshirtH, tshirtX, tshirtY;
  if (garment) {
    tshirtW = (garment.bodyMapping?.shirtWidthInches || sizeData.bodyWidth) * ppi;
    tshirtH = (garment.bodyMapping?.shirtHeightInches || sizeData.bodyLength) * ppi;
    tshirtX = (CANVAS_WIDTH - tshirtW) / 2;
    tshirtY = (CANVAS_HEIGHT - tshirtH) / 2;
    await drawRecoloredGarment(ctx, garment, tshirtX, tshirtY, tshirtW, tshirtH, color.hex);
  } else {
    tshirtW = sizeData.bodyWidth * pxPerInchW;
    tshirtH = sizeData.bodyLength * pxPerInchH;
    tshirtX = (CANVAS_WIDTH - tshirtW) / 2;
    tshirtY = CANVAS_HEIGHT * 0.20 + (maxTshirtH - tshirtH) / 2;
    drawTshirt(ctx, color.hex, side, { tshirtX, tshirtY, tshirtW, tshirtH });
  }

  const artW = print.width_in * ppi, artH = print.height_in * ppi;
  const x = tshirtX + tshirtW / 2 + placement.center_x_in * ppi - artW / 2;
  const y = tshirtY + placement.top_in * ppi;
  ctx.drawImage(artwork, x, y, artW, artH);
  const outside = x < tshirtX || y < tshirtY || x + artW > tshirtX + tshirtW || y + artH > tshirtY + tshirtH;

  if (label) drawLabel(ctx, label);
  return { canvas, outside };
}

function drawLabel(ctx, lines) {
  const pad = 70, x = 120, width = CANVAS_WIDTH - 240, lineH = 64;
  const height = pad * 2 + lines.length * lineH - 10;
  const y = CANVAS_HEIGHT - height - 60;
  ctx.save();
  ctx.fillStyle = 'rgba(255,255,255,0.96)';
  ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 4;
  ctx.beginPath(); ctx.roundRect(x, y, width, height, 28); ctx.fill(); ctx.stroke();
  ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  lines.forEach((text, i) => {
    let size = i === 0 ? 52 : 42;
    ctx.font = `${i === 0 ? 'bold' : '500'} ${size}px Arial, sans-serif`;
    while (ctx.measureText(text).width > width - pad * 2 && size > 22) { size -= 2; ctx.font = `${i === 0 ? 'bold' : '500'} ${size}px Arial, sans-serif`; }
    ctx.fillStyle = i === 0 ? '#0f172a' : '#334155';
    ctx.fillText(text, x + pad, y + pad + i * lineH);
  });
  ctx.restore();
}

export function labelLines({ garmentName, color, size, side, placement, print, requestedWidth, artworkRow, orderId, jobId }) {
  return [
    `${garmentName} · ${color.name} · ${size} · ${side.toUpperCase()}`,
    `${placement.label}: ${print.width_in}" × ${print.height_in}" (${SCALE_TEXT[print.scale_status]})`,
    `Requested width ${requestedWidth ? `${requestedWidth}"` : '—'} · max ${placement.max_width_in}" × ${placement.max_height_in}" · artwork ${artworkRow.width_px}×${artworkRow.height_px} px (${artworkRow.analysis.ratio}) · ${Math.round(artworkRow.width_px / print.width_in)} DPI`,
    [orderId && `Order ${orderId}`, artworkRow.id, jobId].filter(Boolean).join(' · '),
  ];
}

// DesignCanvas.drawTshirt — the vector shirt used when no garment photo fits.
function drawTshirt(ctx, color, side, { tshirtX, tshirtY, tshirtW, tshirtH }) {
  const cx = tshirtX + tshirtW / 2;
  const shoulderY = tshirtY - tshirtH * 0.12;
  const bodyBottom = tshirtY + tshirtH + tshirtH * 0.05;
  const bodyLeft = tshirtX - tshirtW * 0.05;
  const bodyRight = tshirtX + tshirtW + tshirtW * 0.05;
  const sleeveOuterLeft = tshirtX - tshirtW * 0.35;
  const sleeveOuterRight = tshirtX + tshirtW + tshirtW * 0.35;
  const sleeveBottomY = tshirtY + tshirtH * 0.2;
  const collarWidth = tshirtW * 0.14;
  const collarDepth = side === 'front' ? tshirtH * 0.08 : tshirtH * 0.03;

  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.25)';
  ctx.shadowBlur = 30;
  ctx.shadowOffsetY = 8;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(bodyLeft, sleeveBottomY);
  ctx.lineTo(sleeveOuterLeft + tshirtW * 0.06, sleeveBottomY - tshirtH * 0.04);
  ctx.lineTo(sleeveOuterLeft, shoulderY + tshirtH * 0.1);
  ctx.lineTo(bodyLeft, shoulderY);
  ctx.lineTo(cx - collarWidth, shoulderY);
  ctx.quadraticCurveTo(cx, shoulderY + collarDepth, cx + collarWidth, shoulderY);
  ctx.lineTo(bodyRight, shoulderY);
  ctx.lineTo(sleeveOuterRight, shoulderY + tshirtH * 0.1);
  ctx.lineTo(sleeveOuterRight - tshirtW * 0.06, sleeveBottomY - tshirtH * 0.04);
  ctx.lineTo(bodyRight, sleeveBottomY);
  ctx.lineTo(bodyRight, bodyBottom);
  ctx.quadraticCurveTo(cx, bodyBottom + tshirtH * 0.01, bodyLeft, bodyBottom);
  ctx.lineTo(bodyLeft, sleeveBottomY);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  const shade = ctx.createLinearGradient(bodyLeft, 0, bodyRight, 0);
  shade.addColorStop(0, 'rgba(0,0,0,0.08)');
  shade.addColorStop(0.15, 'rgba(0,0,0,0.02)');
  shade.addColorStop(0.5, 'rgba(0,0,0,0)');
  shade.addColorStop(0.85, 'rgba(0,0,0,0.02)');
  shade.addColorStop(1, 'rgba(0,0,0,0.08)');
  ctx.save();
  ctx.fillStyle = shade;
  ctx.fill();
  ctx.restore();

  ctx.strokeStyle = 'rgba(0,0,0,0.2)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(cx - collarWidth, shoulderY);
  ctx.quadraticCurveTo(cx, shoulderY + collarDepth, cx + collarWidth, shoulderY);
  ctx.stroke();

  ctx.strokeStyle = 'rgba(0,0,0,0.05)';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(bodyLeft, shoulderY); ctx.lineTo(bodyLeft, sleeveBottomY); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(bodyRight, shoulderY); ctx.lineTo(bodyRight, sleeveBottomY); ctx.stroke();
}

export const SIZES = SIZE_ORDER;
export const COLORS = TSHIRT_COLORS;
