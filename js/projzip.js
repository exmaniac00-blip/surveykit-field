// Project zip read/write – the same layout as surveykit/storage.py export_zip/import_zip:
// session.json (photo pixels referenced by path) + photos/<station>/<id>.jpg, map/overlay.png, branding/logo.png.
import { strFromU8, strToU8, unzipSync, zipSync } from '../vendor/fflate.js';

const safe = (s) => String(s).replace(/[^A-Za-z0-9._-]+/g, '_') || 'x';
export function b64ToBytes(b64) {
  const bin = atob(String(b64).replace(/\s+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
export function bytesToB64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}

export function exportZip(session) {
  const s = JSON.parse(JSON.stringify(session));
  const files = {};
  for (const [st, lst] of Object.entries(s.photos || {})) {
    for (const p of lst) {
      const path = `photos/${safe(st)}/${safe(p.id)}.jpg`;
      files[path] = [b64ToBytes(p.data_b64), { level: 0 }];        // JPEG: already compressed
      delete p.data_b64;
      p.file = path;
    }
  }
  const ov = (s.map || {}).overlay;
  if (ov && ov.png_b64) { files['map/overlay.png'] = [b64ToBytes(ov.png_b64), { level: 0 }]; delete ov.png_b64; ov.file = 'map/overlay.png'; }
  if ((s.branding || {}).logo_b64) { files['branding/logo.png'] = [b64ToBytes(s.branding.logo_b64), { level: 0 }]; delete s.branding.logo_b64; s.branding.file = 'branding/logo.png'; }
  files['session.json'] = strToU8(JSON.stringify(s, null, 2));
  return zipSync(files, { level: 6, mtime: new Date('2026-01-01T00:00:00Z') });
}

export function importZip(bytes) {
  let z;
  try { z = unzipSync(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)); } catch { throw new Error('Not a valid SurveyKit project zip.'); }
  if (!z['session.json']) throw new Error('Zip has no session.json.');
  const data = JSON.parse(strFromU8(z['session.json']));
  for (const lst of Object.values(data.photos || {})) {
    for (const p of lst) {
      if (!p.data_b64 && z[p.file]) p.data_b64 = bytesToB64(z[p.file]);
      delete p.file;
    }
  }
  const ov = (data.map || {}).overlay;
  if (ov && !ov.png_b64 && z[ov.file]) { ov.png_b64 = bytesToB64(z[ov.file]); delete ov.file; }
  const b = data.branding;
  if (b && !b.logo_b64 && z[b.file]) { b.logo_b64 = bytesToB64(z[b.file]); delete b.file; }
  return data;
}

// SHA-256: WebCrypto when available (secure contexts: https / localhost); a small pure-JS fallback otherwise,
// so the app still works when opened over plain http on a LAN.
const K = new Uint32Array([0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb,
  0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f,
  0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);
export function sha256Sync(u8) {
  const n = u8.length, len = ((n + 9 + 63) >> 6) << 6, m = new Uint8Array(len);
  m.set(u8); m[n] = 0x80;
  const dv = new DataView(m.buffer);
  dv.setUint32(len - 8, Math.floor(n / 0x20000000)); dv.setUint32(len - 4, (n << 3) >>> 0);
  const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const W = new Uint32Array(64), r = (x, k) => (x >>> k) | (x << (32 - k));
  for (let o = 0; o < len; o += 64) {
    for (let i = 0; i < 16; i++) W[i] = dv.getUint32(o + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = W[i - 15], b = W[i - 2];
      W[i] = (W[i - 16] + (r(a, 7) ^ r(a, 18) ^ (a >>> 3)) + W[i - 7] + (r(b, 17) ^ r(b, 19) ^ (b >>> 10))) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (r(e, 6) ^ r(e, 11) ^ r(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + W[i]) >>> 0;
      const t2 = ((r(a, 2) ^ r(a, 13) ^ r(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    [a, b, c, d, e, f, g, h].forEach((v, i) => { H[i] = (H[i] + v) >>> 0; });
  }
  return [...H].map((x) => x.toString(16).padStart(8, '0')).join('');
}
export async function sha256Hex(data) {
  const u8 = typeof data === 'string' ? strToU8(data) : data;
  if (!(globalThis.crypto && crypto.subtle)) return sha256Sync(u8);
  const h = await crypto.subtle.digest('SHA-256', u8);
  return [...new Uint8Array(h)].map((x) => x.toString(16).padStart(2, '0')).join('');
}
// crypto.randomUUID is also secure-context only
export const uuid = () => (globalThis.crypto && crypto.randomUUID ? crypto.randomUUID()
  : [...crypto.getRandomValues(new Uint8Array(16))].map((x, i) => ([4, 6, 8, 10].includes(i) ? '-' : '') + x.toString(16).padStart(2, '0')).join(''));
