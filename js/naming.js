// Port of surveykit/naming.py – project folder names YYMMDD-###-CLIENT (tested against Python fixtures).
const INVALID = /[<>:"/\\|?*\x00-\x1f#%]/g;
const RESERVED = new Set(['CON', 'PRN', 'AUX', 'NUL', ...[1, 2, 3, 4, 5, 6, 7, 8, 9].flatMap((i) => [`COM${i}`, `LPT${i}`])]);
const STOP = new Set(['PTY', 'LTD', 'LIMITED', 'INC', 'CO', 'CORP', 'CORPORATION', 'COMPANY', 'GROUP', 'THE', 'AND', 'OF',
  'HOLDINGS', 'TRUST', 'AUSTRALIA', 'AUST', 'PNG', 'LLC', 'PLC']);
const PATTERN = /^(\d{6})-(\d{3,})-([A-Z0-9]{1,8})(?:-(\d+))?$/;

const p2 = (n) => String(n).padStart(2, '0');
export function yymmdd(d, today = new Date()) {
  const t = String(d ?? '').trim();
  let m;
  const ok = (y, mo, da) => { const dt = new Date(Date.UTC(y, mo - 1, da)); return dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === da; };
  if ((m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t)) && ok(+m[1], +m[2], +m[3])) return m[1].slice(2) + m[2] + m[3];
  if ((m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(t)) && ok(+m[3], +m[2], +m[1])) return m[3].slice(2) + p2(m[2]) + p2(m[1]);
  if ((m = /^(\d{4})(\d{2})(\d{2})$/.exec(t)) && ok(+m[1], +m[2], +m[3])) return m[1].slice(2) + m[2] + m[3];
  if ((m = /^(\d{2})(\d{2})(\d{2})$/.exec(t)) && ok(2000 + +m[1], +m[2], +m[3])) return t;
  return String(today.getFullYear()).slice(2) + p2(today.getMonth() + 1) + p2(today.getDate());
}
export function padNumber(n) {
  const s = String(n ?? '').trim();
  if (!/^\d+$/.test(s)) throw new Error(`Project number must be digits only (got '${n}').`);
  return String(parseInt(s, 10)).padStart(3, '0');
}
export function sanitizeCode(code) {
  const c = String(code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
  return RESERVED.has(c) ? c + 'X' : c;
}
export function suggestClientCode(name) {
  const words = (String(name ?? '').toUpperCase().match(/[A-Z0-9]+/g) || []).filter((w) => !STOP.has(w));
  if (!words.length) return '';
  let code;
  if (words.length >= 3) code = words.map((w) => w[0]).join('').slice(0, 4);
  else { code = words[0].slice(0, 4); if (code.length < 3) code = words.join('').slice(0, 4); }
  return sanitizeCode(code);
}
export function sanitizeName(name) {
  let n = String(name ?? '').replace(INVALID, '');
  n = n.trim().replace(/\s+/g, '-').replace(/-{2,}/g, '-').replace(/^[.-]+|[.-]+$/g, '').slice(0, 100);
  if (RESERVED.has(n.toUpperCase().split('.')[0])) n += '_';
  return n;
}
export function baseName(p) {
  const num = String(p.project_no ?? '').trim();
  if (!num) throw new Error('Enter a project number (### – e.g. 45 → 045).');
  const code = sanitizeCode(p.client_code || suggestClientCode(p.client || ''));
  if (code.length < 3) throw new Error('Enter a client code of 3–4 letters/digits (or a client name to suggest one).');
  return `${yymmdd(p.date)}-${padNumber(num)}-${code}`;
}
export function unique(name, existing = []) {
  const taken = new Set(existing.map((e) => String(e).replace(/\.zip$/i, '').toUpperCase()));
  if (!taken.has(name.toUpperCase())) return name;
  let i = 2;
  while (taken.has(`${name}-${i}`.toUpperCase())) i++;
  return `${name}-${i}`;
}
export const folderName = (p, existing = []) => unique(sanitizeName(p.folder_name || '') || baseName(p), existing);
export function tryFolderName(p, existing = [], fallback = 'surveykit') {
  try { return [folderName(p, existing), '']; } catch (e) { return [unique(sanitizeName(p.title || '') || fallback, existing), e.message]; }
}
export function parse(name) {
  const m = PATTERN.exec(String(name ?? '').replace(/\.zip$/i, ''));
  return m ? { date: m[1], number: parseInt(m[2], 10), client: m[3], suffix: parseInt(m[4] || '1', 10) } : null;
}
export const nextNumber = (existing = []) => Math.max(0, ...existing.map(parse).filter(Boolean).map((p) => p.number)) + 1;
