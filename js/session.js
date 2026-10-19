// Session helpers for Field Mode. The session object IS the desktop's session.json (schema 5) – the phone only
// fills the fields it edits and keeps everything else untouched, so the desktop opens it unchanged.
export const FIELD_EQUIPMENT = ['instrument', 'serial', 'prism', 'prism_constant_mm', 'target', 'level', 'staff',
  'gnss_receiver', 'gnss_antenna', 'base_station', 'calibration_date'];
export const defaultField = () => ({ equipment: Object.fromEntries(FIELD_EQUIPMENT.map((k) => [k, ''])), gear: [], benchmarks: [],
  reference_notes: '', checks_done: false, step: 1 });

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
function fill(target, tpl) {
  for (const [k, v] of Object.entries(tpl)) {
    if (!(k in target) || target[k] === undefined) target[k] = structuredClone(v);
    else if (isObj(v) && isObj(target[k])) fill(target[k], v);
  }
  return target;
}
export function todayIso(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function newSession(options, prefs = {}) {
  const s = structuredClone(options.new_session);
  s.project.date = todayIso();
  if (prefs.surveyor) s.project.surveyor = prefs.surveyor;
  if (prefs.datum) s.datum.horizontal = prefs.datum;
  if (prefs.vertical) s.datum.vertical = prefs.vertical;
  s.field = defaultField();
  return s;
}
export function normalise(s, options) {
  if (!isObj(s)) throw new Error('Session file is not a JSON object.');
  fill(s, options.new_session);
  s.field = fill(isObj(s.field) ? s.field : {}, defaultField());
  for (const k of ['observations']) if (!Array.isArray(s[k])) s[k] = [];
  if (!Array.isArray(s.levelling.rows)) s.levelling.rows = [];
  if (!Array.isArray(s.gnss.points)) s.gnss.points = [];
  if (!isObj(s.photos)) s.photos = {};
  return s;
}
// A → B, Z → AA, STN9 → STN10, 1 → 2, blank → A
export function nextId(id) {
  const s = String(id ?? '').trim();
  if (!s) return 'A';
  const m = /^(.*?)(\d+)$/.exec(s);
  if (m) return m[1] + String(parseInt(m[2], 10) + 1).padStart(m[2].length, '0');
  if (/^[A-Z]+$/.test(s)) {
    const a = s.split('');
    let i = a.length - 1;
    while (i >= 0 && a[i] === 'Z') { a[i] = 'A'; i--; }
    if (i < 0) return 'A' + a.join('');
    a[i] = String.fromCharCode(a[i].charCodeAt(0) + 1);
    return a.join('');
  }
  return s + '2';
}
// Last-value memory: a new row copies the "sticky" fields from the previous row of the same kind
export const STICKY = { obs: ['hi', 'ht', 'dist_type', 'code'], level: [], gnss: ['ant_h', 'solution', 'code'] };
export function newObsRow(prev, columns) {
  const r = Object.fromEntries(columns.map((c) => [c, '']));
  if (prev) {
    for (const k of STICKY.obs) r[k] = prev[k] ?? '';
    r.station = String(prev.fs || '').trim() || nextId(prev.station);
    r.bs = String(prev.station || '');
    r.fs = nextId(r.station);
  } else { r.station = 'A'; r.fs = 'B'; r.dist_type = 'H'; }
  return r;
}
export function newGnssRow(prev, columns) {
  const r = Object.fromEntries(columns.map((c) => [c, '']));
  if (prev) { for (const k of STICKY.gnss) r[k] = prev[k] ?? ''; r.id = nextId(prev.id); } else { r.id = 'GPS01'; r.solution = 'Fixed'; }
  return r;
}
export function newLevelRow(prev, columns) {
  const r = Object.fromEntries(columns.map((c) => [c, '']));
  r.station = prev ? nextId(prev.station) : 'BM1';
  return r;
}
export function stationsOf(s) {
  const ids = [...s.observations.map((r) => r.station), ...s.gnss.points.map((p) => p.id), ...s.levelling.rows.map((r) => r.station),
    ...(s.field.benchmarks || []).map((b) => b.id)].map((x) => String(x ?? '').trim()).filter(Boolean);
  return [...new Set(ids)];
}
