// Small shared pieces: API errors, the render queues, input parsing helpers and
// the PNG DPI writer.
export class ApiError extends Error {
  constructor(status, code, message, extra) { super(message); this.status = status; this.code = code; this.extra = extra; }
}
export const bad = (message, code = 'invalid_request', extra) => new ApiError(400, code, message, extra);

// Renders are memory-heavy, so they take turns.
export function limiter(concurrency, maxWaiting) {
  let active = 0;
  const waiting = [];
  const release = () => { active -= 1; if (waiting.length) { active += 1; waiting.shift()(); } };
  return async (fn) => {
    if (active >= concurrency) {
      if (waiting.length >= maxWaiting) throw new ApiError(503, 'busy', 'The renderer is busy. Retry in a minute.');
      await new Promise((resolve) => waiting.push(resolve));
    } else active += 1;
    try { return await fn(); } finally { release(); }
  };
}

export function num(v, name, { min = -Infinity, max = Infinity, def } = {}) {
  if (v === undefined || v === null || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw bad(`${name} must be a number between ${min} and ${max}.`);
  return n;
}

export function bool(v, def = false) {
  if (v === undefined || v === null || v === '') return def;
  if (typeof v === 'boolean') return v;
  return !['false', '0', 'no', 'off'].includes(String(v).toLowerCase());
}

export function str(v, max = 100) {
  if (v === undefined || v === null || v === '') return null;
  return String(v).trim().slice(0, max) || null;
}

export function jsonField(v, name) {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { throw bad(`${name} must be valid JSON.`); }
}

// pHYs chunk after IHDR so RIP software reads the file at the right DPI (GangSheet.embedDpiInPng).
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
export function withDpi(png, dpi) {
  const ppm = Math.round(dpi * 39.3701);
  const chunk = Buffer.alloc(21);
  chunk.writeUInt32BE(9, 0);
  chunk.write('pHYs', 4, 'ascii');
  chunk.writeUInt32BE(ppm, 8); chunk.writeUInt32BE(ppm, 12); chunk[16] = 1;
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 17)), 17);
  return Buffer.concat([png.subarray(0, 33), chunk, png.subarray(33)]);
}
