// Getting artwork bytes in: multipart upload, base64 / data URL, or a public URL.
// URL fetches can never reach private networks or this host (SSRF guard).
import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { loadImage } from '@napi-rs/canvas';
import { ApiError, bad } from './common.js';

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 64_000_000;

export function sniffImage(buf) {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) return { type: 'png', w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i += 1; continue; }
      const marker = buf[i + 1];
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { type: 'jpeg', h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
    return { type: 'jpeg', w: 0, h: 0 };
  }
  return null;
}

// Everything an artwork URL must never reach: loopback, private and link-local
// ranges, IPv4-mapped/NAT64 forms of them, and this host's own public addresses.
const BLOCKED = new net.BlockList();
for (const [a, p] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3]]) BLOCKED.addSubnet(a, p, 'ipv4');
// IPv4-mapped IPv6 (::ffff:a.b.c.d) is matched by the IPv4 rules above — BlockList
// maps it — so no ::ffff:0:0/96 rule: that one would match every IPv4 address.
for (const [a, p] of [['::', 127], ['64:ff9b::', 96], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]) BLOCKED.addSubnet(a, p, 'ipv6');
for (const ip of (process.env.SELF_IPS || '').split(',').map(x => x.trim()).filter(Boolean)) BLOCKED.addAddress(ip, net.isIPv6(ip) ? 'ipv6' : 'ipv4');

export function isPrivateAddress(ip) {
  const type = net.isIPv4(ip) ? 'ipv4' : net.isIPv6(ip) ? 'ipv6' : null;
  return !type || BLOCKED.check(ip, type);
}

// The address is vetted inside the socket's own DNS lookup, so the one that is
// checked is the one connected to (no DNS-rebinding window between the two).
function safeLookup(hostname, options, callback) {
  dns.lookup(hostname, { all: true }).then((addrs) => {
    const bad = !addrs.length || addrs.some(a => isPrivateAddress(a.address));
    if (bad) return callback(Object.assign(new Error('blocked address'), { code: 'EBLOCKED' }));
    if (options.all) return callback(null, addrs);
    callback(null, addrs[0].address, addrs[0].family);
  }, callback);
}

function download(url) {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.get(url, { lookup: safeLookup, timeout: 30_000, headers: { 'User-Agent': 'DesignStudio-RenderAPI/1.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { res.resume(); return resolve({ redirect: res.headers.location }); }
      if (res.statusCode !== 200) { res.resume(); return reject(bad(`Artwork URL answered ${res.statusCode}: ${url.href.slice(0, 200)}`)); }
      if (Number(res.headers['content-length'] || 0) > MAX_UPLOAD_BYTES) { res.destroy(); return reject(bad('Artwork is larger than 50 MB.')); }
      const chunks = []; let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_UPLOAD_BYTES) { res.destroy(); reject(bad('Artwork is larger than 50 MB.')); } else chunks.push(c);
      });
      res.on('end', () => resolve({ body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', (e) => reject(e.code === 'EBLOCKED' ? bad('Artwork URLs must point to a public address.')
      : e instanceof ApiError ? e : bad(`Could not download the artwork URL (${e.code || e.message}).`)));
  });
}

export async function fetchPublicImage(rawUrl) {
  for (let hop = 0; hop < 4; hop++) {
    let url;
    try { url = new URL(rawUrl); } catch { throw bad(`Not a valid URL: ${String(rawUrl).slice(0, 200)}`); }
    if (!['http:', 'https:'].includes(url.protocol)) throw bad('Artwork URLs must be http or https.');
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(host) && isPrivateAddress(host)) throw bad('Artwork URLs must point to a public address.');
    const res = await download(url);
    if (res.redirect) { rawUrl = new URL(res.redirect, url).href; continue; }
    return res.body;
  }
  throw bad('Artwork URL redirected too many times.');
}

export function decodeBase64(s) {
  const b64 = String(s).replace(/^data:[^;]+;base64,/, '').replace(/\s/g, '');
  const buf = Buffer.from(b64, 'base64');
  if (!buf.length) throw bad('artwork_base64 is empty or not base64.');
  if (buf.length > MAX_UPLOAD_BYTES) throw bad('Artwork is larger than 50 MB.');
  return buf;
}

export async function decodeImage(buf, label, { pngOnly = false } = {}) {
  const info = sniffImage(buf);
  if (!info || (pngOnly && info.type !== 'png')) {
    throw bad(pngOnly ? `${label}: gang sheet artwork must be PNG (DTF film needs its transparency).` : `${label}: artwork must be a PNG or JPEG.`, 'unsupported_image');
  }
  const complete = info.type === 'png'
    ? buf.lastIndexOf(Buffer.from('IEND', 'ascii')) > buf.length - 64
    : buf.lastIndexOf(Buffer.from([0xff, 0xd9])) > 2;
  if (!complete) throw bad(`${label}: the image file is incomplete (cut off in transfer?).`, 'unsupported_image');
  if (info.w * info.h > MAX_IMAGE_PIXELS) throw bad(`${label}: ${info.w}×${info.h} px is over the 64-megapixel limit.`, 'image_too_large');
  try {
    return await loadImage(buf);
  } catch {
    throw bad(`${label}: the image could not be decoded.`, 'unsupported_image');
  }
}

export async function artworkBuffer(source, files, label) {
  if (Buffer.isBuffer(source.upload?.buffer)) return source.upload.buffer;
  if (source.file != null) {
    const f = files.find(x => x.fieldname === source.file || x.originalname === source.file);
    if (!f) throw bad(`${label}: no uploaded file named "${source.file}".`);
    return f.buffer;
  }
  if (source.artwork_base64) return decodeBase64(source.artwork_base64);
  if (source.artwork_url) return fetchPublicImage(source.artwork_url);
  throw bad(`${label}: send the artwork as a file upload, artwork_url or artwork_base64.`);
}
