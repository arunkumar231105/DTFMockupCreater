// Gang sheet builder — the server-side twin of GangSheet.jsx. Layout comes from
// the very same packing engine (src/utils/packingStrategies.js) the Gang Sheet,
// Calculator and Optimizer share, and each sheet is drawn the way
// renderSheetCanvas() draws it for "Download" / "Save GS".
import { createCanvas } from '@napi-rs/canvas';
import QRCode from 'qrcode';
import { packSheets } from '../src/utils/packingStrategies.js';

export const SHEET_WIDTH_INCHES = 22; // default film width (the studio's roll)
export const MAX_SHEET_HEIGHT = 108;  // default max sheet length
export const DPI = 300;
export const COST_PER_FOOT = 5;
const HEADER_INCHES = 1.2;

// GangSheet.handleFileSelect: native size at 300 DPI, capped to 21" wide.
export function defaultItemSize(imgW, imgH, filmWidth = SHEET_WIDTH_INCHES) {
  const aspect = imgW / imgH;
  let w = +(imgW / DPI).toFixed(2), h = +(imgH / DPI).toFixed(2);
  if (w > filmWidth - 1) { w = filmWidth - 1; h = +(w / aspect).toFixed(2); }
  return { w, h };
}

/** artworks: [{ id, name, image, widthInches, heightInches, quantity }] */
export function layoutGangSheet(artworks, { hGap, vGap, margins, filmWidth = SHEET_WIDTH_INCHES, maxLength = MAX_SHEET_HEIGHT }) {
  const items = [];
  for (const art of artworks) {
    for (let i = 0; i < art.quantity; i++) items.push({ artworkId: art.id, w: art.widthInches, h: art.heightInches, qIdx: i });
  }
  return packSheets(items, filmWidth, hGap, vGap, margins, maxLength);
}

export function sheetHeightInches(sheet, header) {
  return sheet.totalHeight + (header.include ? HEADER_INCHES + header.topMargin : 0);
}

export async function renderSheet(sheet, sheetIndex, totalSheets, artworks, header, filmWidth = SHEET_WIDTH_INCHES) {
  const byId = new Map(artworks.map(a => [a.id, a]));
  const exportWidth = Math.round(filmWidth * DPI);
  const HEADER_HEIGHT = header.include ? Math.round(HEADER_INCHES * DPI) : 0;
  const HEADER_MARGIN_TOP = header.include ? Math.round(header.topMargin * DPI) : 0;
  const totalHeightPx = Math.round(sheet.totalHeight * DPI) + HEADER_HEIGHT + HEADER_MARGIN_TOP;

  const canvas = createCanvas(exportWidth, totalHeightPx);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, exportWidth, totalHeightPx); // transparent film

  if (header.include) await drawHeader(ctx, { exportWidth, HEADER_HEIGHT, headerStartY: HEADER_MARGIN_TOP, sheetIndex, totalSheets, artworks, header });

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  for (const item of sheet.items) {
    const art = byId.get(item.artworkId);
    if (!art) continue;
    const img = art.image;
    const x = Math.round(item.x * DPI);
    const y = Math.round(item.y * DPI) + HEADER_HEIGHT + HEADER_MARGIN_TOP;
    const w = Math.round(item.w * DPI);
    const h = Math.round(item.h * DPI);
    if (item.rotated) {
      ctx.save();
      ctx.translate(x + w, y);
      ctx.rotate(Math.PI / 2);
      ctx.drawImage(img, 0, 0, img.width, img.height, 0, 0, h, w);
      ctx.restore();
    } else {
      ctx.drawImage(img, 0, 0, img.width, img.height, x, y, w, h);
    }
  }
  return canvas;
}

async function drawHeader(ctx, { exportWidth, HEADER_HEIGHT, headerStartY, sheetIndex, totalSheets, artworks, header }) {
  ctx.strokeStyle = '#333333';
  ctx.lineWidth = 4;
  ctx.strokeRect(6, headerStartY + 6, exportWidth - 12, HEADER_HEIGHT - 12);

  const colPO = 40;
  const colTable = exportWidth * 0.2;
  const colQR = exportWidth * 0.76;

  ctx.textAlign = 'left';
  ctx.fillStyle = '#555555'; ctx.font = '500 28px Arial, sans-serif';
  ctx.fillText('PO#:', colPO, headerStartY + 60);
  ctx.fillStyle = '#000000'; ctx.font = 'bold 48px Arial, sans-serif';
  ctx.fillText(header.poNumber || '—', colPO, headerStartY + 110);
  ctx.strokeStyle = '#cccccc'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(colPO, headerStartY + 135); ctx.lineTo(colTable - 30, headerStartY + 135); ctx.stroke();
  ctx.fillStyle = '#555555'; ctx.font = '500 28px Arial, sans-serif';
  ctx.fillText('ORDER#:', colPO, headerStartY + 175);
  ctx.fillStyle = '#000000'; ctx.font = 'bold 48px Arial, sans-serif';
  ctx.fillText(header.orderNumber || '—', colPO, headerStartY + 225);

  if (totalSheets > 1) {
    ctx.fillStyle = '#2563eb'; ctx.font = 'bold 36px Arial, sans-serif';
    ctx.fillText(`Sheet ${sheetIndex + 1} of ${totalSheets}`, colPO, headerStartY + HEADER_HEIGHT - 30);
  }

  ctx.fillStyle = '#222222'; ctx.font = 'bold 22px Arial, sans-serif'; ctx.textAlign = 'center';
  const tColName = colTable + 100, tColThumb = colTable + 280, tColSize = colTable + 440, tColQty = colTable + 580;
  ctx.fillText('ARTWORK NO.', tColName, headerStartY + 50);
  ctx.fillText('THUMB', tColThumb, headerStartY + 50);
  ctx.fillText('SIZE', tColSize, headerStartY + 50);
  ctx.fillText('QTY', tColQty, headerStartY + 50);
  ctx.strokeStyle = '#888888'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(colTable, headerStartY + 62); ctx.lineTo(colQR - 30, headerStartY + 62); ctx.stroke();

  const maxRows = Math.min(artworks.length, 4);
  const rowH = (HEADER_HEIGHT - 90) / Math.max(maxRows, 1);
  for (let i = 0; i < maxRows; i++) {
    const art = artworks[i];
    const rowY = headerStartY + 70 + i * rowH;
    ctx.fillStyle = '#000000'; ctx.font = '500 22px Arial, sans-serif'; ctx.textAlign = 'center';
    const name = art.name.length > 14 ? art.name.substring(0, 14) + '…' : art.name;
    ctx.fillText(name, tColName, rowY + rowH / 2 + 7);
    const thumbSize = Math.min(rowH - 14, 55);
    const thumbX = tColThumb - thumbSize / 2, thumbY = rowY + (rowH - thumbSize) / 2;
    ctx.drawImage(art.image, thumbX, thumbY, thumbSize, thumbSize);
    ctx.strokeStyle = '#cccccc'; ctx.lineWidth = 1;
    ctx.strokeRect(thumbX, thumbY, thumbSize, thumbSize);
    ctx.fillStyle = '#000000'; ctx.font = 'bold 24px Arial, sans-serif';
    ctx.fillText(`${art.widthInches}" x ${art.heightInches}"`, tColSize, rowY + rowH / 2 + 7);
    ctx.font = 'bold 28px Arial, sans-serif';
    ctx.fillText(`${art.quantity}`, tColQty, rowY + rowH / 2 + 7);
  }

  // A real, scannable QR code (the studio page draws a placeholder pattern).
  if (header.orderLink) {
    const qrSize = HEADER_HEIGHT - 80;
    const qr = QRCode.create(header.orderLink, { errorCorrectionLevel: 'M' });
    const n = qr.modules.size;
    const cell = qrSize / n;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(colQR, headerStartY + 30, qrSize, qrSize);
    ctx.fillStyle = '#000000';
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (qr.modules.get(r, c)) ctx.fillRect(colQR + c * cell, headerStartY + 30 + r * cell, Math.ceil(cell), Math.ceil(cell));
      }
    }
    ctx.fillStyle = '#444444'; ctx.font = '500 18px Arial, sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('Scan for order details', colQR + qrSize / 2, headerStartY + HEADER_HEIGHT - 20);
  }
}

/** Small copy for reviewing a sheet on screen; the print file stays full size. */
export async function previewOf(canvas, maxWidth = 1100) {
  const scale = Math.min(1, maxWidth / canvas.width);
  const c = createCanvas(Math.max(1, Math.round(canvas.width * scale)), Math.max(1, Math.round(canvas.height * scale)));
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, c.width, c.height);
  const cell = 12; ctx.fillStyle = '#eef2f7';
  for (let y = 0; y < c.height; y += cell) for (let x = (y / cell) % 2 ? cell : 0; x < c.width; x += cell * 2) ctx.fillRect(x, y, cell, cell);
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvas, 0, 0, c.width, c.height);
  return c.encode('png');
}
