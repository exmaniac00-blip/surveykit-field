// SurveyKit Field Mode – UI. Six steps: project → equipment → reference → observations → photos → checks & sync.
// Everything is saved to IndexedDB as you type; sync to Google Drive is optional and resumable.
import * as C from './calc.js';
import * as N from './naming.js';
import { exportZip, importZip, bytesToB64, uuid } from './projzip.js';
import { openStore } from './store.js';
import { newSession, normalise, newObsRow, newGnssRow, newLevelRow, stationsOf } from './session.js';
import * as SY from './sync.js';
import { DriveAdapter } from './drive.js';
import * as GIS from './gis.js';

export const VERSION = '4.0.0';
const STEPS = ['Job', 'Gear', 'Ref', 'Obs', 'Photos', 'Check'];   // short – they share one row on a phone
const $ = (s) => document.querySelector(s);
const st = { view: 'list', step: 1, rec: null, obsTab: 'traverse', editIdx: null, checks: null, syncMsg: '', busy: false, photoStation: '' };
let store, options, tolData, prefs, gear;

// --------------------------------------------------------------------------------------------- DOM helper
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) if (c !== null && c !== undefined && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}
function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), ms);
}
const S = () => st.rec.session;

// --------------------------------------------------------------------------------------------- persistence
let saveTimer = null;
function changed(rerender = false) {
  SY.touch(S());
  st.rec.dirty = true;
  st.rec.updated_at = new Date().toISOString();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => store.putProject(st.rec), 300);
  if (rerender) render(); else header();
}
async function savePrefs() { await store.set('prefs', prefs); }

// field inputs bound to an object key
function field(label, obj, key, o = {}) {
  const inp = h(o.multiline ? 'textarea' : 'input', {
    type: o.type || 'text', class: o.num ? 'num' : '', inputmode: o.num ? (o.int ? 'numeric' : 'decimal') : o.inputmode,
    value: obj[key] ?? '', placeholder: o.placeholder, autocomplete: 'off', autocapitalize: o.caps ? 'characters' : 'off',
    'aria-label': label, 'data-k': key, enterkeyhint: 'next',
    oninput: (e) => { obj[key] = o.toNumber ? (e.target.value.trim() === '' ? null : Number(e.target.value)) : e.target.value; if (o.after) o.after(e); changed(false); },
  });
  return h('label', {}, label, o.help ? h('small', {}, ' – ', o.help) : null, inp);
}
function select(label, obj, key, choices, o = {}) {
  const sel = h('select', { 'aria-label': label, onchange: (e) => { obj[key] = e.target.value; if (o.after) o.after(e); changed(!!o.rerender); } },
    choices.map(([v, t]) => h('option', { value: v, selected: String(obj[key]) === String(v) }, t)));
  return h('label', {}, label, sel);
}
function seg(choices, cur, onpick) {
  return h('div', { class: 'seg', role: 'group' }, choices.map(([v, t]) => h('button', { class: v === cur ? 'on' : '', 'aria-pressed': v === cur ? 'true' : 'false', onclick: () => onpick(v) }, t)));
}

// --------------------------------------------------------------------------------------------- header / nav
function folder() {
  const P = S().project;
  return (S().sync || {}).project || N.tryFolderName(P, [])[0];
}
function header() {
  const on = navigator.onLine;
  const net = $('#net');
  const conn = GIS.hasToken();
  net.textContent = !on ? 'Offline' : conn ? (st.rec && st.rec.dirty ? 'Not synced' : 'Drive ✓') : 'Online';
  net.className = 'pill ' + (!on ? 'off' : conn && st.rec && !st.rec.dirty ? 'ok' : '');
  $('#sub').textContent = st.rec && st.view === 'project' ? folder() : 'v' + VERSION;
}
function nav() {
  const n = $('#steps');
  n.replaceChildren();
  n.hidden = st.view !== 'project';
  if (st.view !== 'project') return;
  STEPS.forEach((t, i) => n.append(h('button', { class: (st.step === i + 1 ? 'on ' : '') + (i + 1 < st.step ? 'done' : ''), onclick: () => go(i + 1), 'aria-current': st.step === i + 1 ? 'step' : null }, `${i + 1} ${t}`)));
}
function foot() {
  const f = $('#foot');
  f.replaceChildren();
  if (st.view !== 'project') { f.append(h('button', { class: 'pri', onclick: newProject }, '＋ New project'), h('button', { onclick: () => { st.view = 'settings'; render(); } }, '⚙ Settings')); return; }
  f.append(h('button', { disabled: st.step === 1, onclick: () => go(st.step - 1) }, '◀ Back'));
  if (st.step < 6) f.append(h('button', { class: 'pri', onclick: () => go(st.step + 1) }, 'Next ▶'));
  else f.append(h('button', { class: 'ok', onclick: syncNow, disabled: st.busy }, st.busy ? 'Syncing…' : '⟳ Sync'));
}
function go(n) { st.step = Math.min(6, Math.max(1, n)); S().field.step = st.step; st.editIdx = null; changed(true); window.scrollTo(0, 0); }

// --------------------------------------------------------------------------------------------- views
function render() {
  header(); nav(); foot();
  const m = $('#main');
  m.replaceChildren();
  const kids = st.view === 'list' ? viewList() : st.view === 'settings' ? viewSettings() : [null, step1, step2, step3, step4, step5, step6][st.step]();
  m.append(...kids.flat(Infinity).filter((x) => x !== null && x !== undefined && x !== false));
}

function viewList() {
  const out = [h('h2', {}, 'Projects on this phone')];
  const list = h('div', {});
  store.listProjects().then((recs) => {
    if (!recs.length) list.append(h('p', { class: 'big' }, 'No projects yet. Tap ＋ New project.'));
    for (const r of recs) {
      const P = r.session.project;
      list.append(h('div', { class: 'card' },
        h('b', {}, (r.session.sync || {}).project || N.tryFolderName(P, [])[0]), h('div', { class: 'meta' }, `${P.title || 'Untitled'} · ${P.client || ''} · ${P.date || ''}`),
        h('div', { class: 'meta' }, r.dirty ? '● changes not synced' : `synced rev ${(r.session.sync || {}).rev || 0}`),
        h('div', { class: 'row' }, h('button', { class: 'pri', onclick: () => openProject(r.id) }, 'Open'),
          h('button', { onclick: () => download(r) }, '⬇ Zip'))));
    }
  });
  out.push(list, h('h3', {}, 'Open a project zip'),
    h('p', { class: 'hint' }, 'A zip exported from the desktop (Save / load → Export project) or shared from another phone.'),
    h('input', { type: 'file', accept: '.zip,application/zip', 'aria-label': 'Open project zip', onchange: openZipFile }),
    h('h3', {}, 'From Google Drive'),
    h('button', { onclick: pullFromDrive }, '☁ Download a project from Drive'),
    h('p', { class: 'hint' }, 'Field Mode works fully offline. Install it: browser menu → "Add to Home screen".'));
  return out;
}

function viewSettings() {
  const g = h('div', {});
  const drawGear = () => { g.replaceChildren(...gear.map((x, i) => h('div', { class: 'check' }, h('span', { style: 'flex:1' }, x), h('button', { class: 'bad', 'aria-label': `Remove ${x}`, onclick: async () => { gear.splice(i, 1); await store.set('gear', gear); drawGear(); } }, '✕')))); };
  drawGear();
  const newGear = h('input', { placeholder: 'e.g. Prism pole 2.0 m', 'aria-label': 'New gear item' });
  return [h('h2', {}, 'Settings'),
    field('Your name (surveyor)', prefs, 'surveyor', { after: savePrefs }),
    field('Device name', prefs, 'device_id', { after: savePrefs, help: 'shown on the desktop as the requester' }),
    select('Default horizontal datum', prefs, 'datum', datumChoices(), { after: savePrefs }),
    select('Default jurisdiction', prefs, 'jurisdiction', jurChoices(), { after: savePrefs }),
    h('h3', {}, 'Google Drive sync'),
    field('OAuth Web client ID', prefs, 'client_id', { after: savePrefs, help: 'from your own Google Cloud project – see docs/google_drive_setup.md', placeholder: '…apps.googleusercontent.com' }),
    h('div', { class: 'row' }, h('button', { class: 'pri', onclick: connectDrive }, GIS.hasToken() ? '✓ Connected – reconnect' : '🔑 Connect Google Drive'),
      h('button', { onclick: () => { GIS.signOut(); render(); } }, 'Sign out')),
    select('If the desktop and phone both changed a project', prefs, 'policy', [['lww', 'Last write wins (other copy backed up)'], ['keep_both', 'Keep both (mine saved as -conflict-…)']], { after: savePrefs }),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: prefs.auto_sync, onchange: async (e) => { prefs.auto_sync = e.target.checked; await savePrefs(); } }), 'Auto-sync when online'),
    h('h3', {}, 'Saved gear list'), g,
    h('div', { class: 'row' }, newGear, h('button', { onclick: async () => { if (newGear.value.trim()) { gear.push(newGear.value.trim()); await store.set('gear', gear); newGear.value = ''; drawGear(); } } }, 'Add')),
    h('h3', {}, 'Backups (conflict copies)'), backupList(),
    h('p', { class: 'hint' }, `SurveyKit Field v${VERSION}`),
    h('button', { onclick: () => { st.view = 'list'; render(); } }, '◀ Projects')];
}
function backupList() {
  const d = h('div', {});
  store.get('backups', []).then((b) => d.append(...(b.length ? b.map((x) => h('div', { class: 'check' }, h('span', { style: 'flex:1' }, x.name),
    h('button', { onclick: () => saveBytes(x.name, Uint8Array.from(atob(x.b64), (c) => c.charCodeAt(0))) }, '⬇'))) : [h('p', { class: 'hint' }, 'None.')])));
  return d;
}
const datumChoices = () => [...options.datums.Australia, ...options.datums['Papua New Guinea']].map(([c, l]) => [c, l]);
const jurChoices = () => tolData.order.map((j) => [j, `${j} – ${tolData.jurisdictions[j].name}`]);

// ---- step 1
function step1() {
  const s = S(), P = s.project;
  const preview = h('p', { class: 'big', role: 'status' });
  const upd = () => { const [n, why] = N.tryFolderName(P, []); preview.replaceChildren(...[ '📁 ', h('b', {}, n), why ? h('div', { class: 'err' }, why) : ''].filter(Boolean)); };
  upd();
  const ccInput = field('Client code (3–4)', P, 'client_code', { caps: true, placeholder: N.suggestClientCode(P.client) || 'ACME', after: upd });
  return [h('h2', {}, '1 · Project'),
    field('Date', P, 'date', { type: 'date', after: upd }),
    h('div', { class: 'row' }, field('Project no. ###', P, 'project_no', { num: true, int: true, after: upd, placeholder: '045' }), ccInput),
    field('Client', P, 'client', { after: (e) => { ccInput.querySelector('input').placeholder = N.suggestClientCode(e.target.value) || 'ACME'; upd(); } }),
    preview,
    field('Job / site name', P, 'title'), field('Location', P, 'location'), field('Surveyor', P, 'surveyor', { after: (e) => { prefs.surveyor = e.target.value; savePrefs(); } }),
    select('Horizontal datum', s.datum, 'horizontal', datumChoices()),
    select('Height datum', s.datum, 'vertical', options.verticals.map((v) => [v, v])),
    field('Folder name override (optional)', P, 'folder_name', { after: upd, help: 'leave blank for YYMMDD-###-CLIENT' })];
}

// ---- step 2
function step2() {
  const E = S().field.equipment;
  const chosen = new Set(S().field.gear);
  const list = gear.length ? gear.map((g) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: chosen.has(g), onchange: (e) => {
    if (e.target.checked) chosen.add(g); else chosen.delete(g);
    S().field.gear = [...chosen]; changed(false);
  } }), g)) : [h('p', { class: 'hint' }, 'Add your usual gear once in ⚙ Settings – then just tick it here.')];
  return [h('h2', {}, '2 · Equipment & setup'),
    field('Instrument', S().project, 'instrument', { placeholder: 'e.g. Leica TS16 1"', after: (e) => { E.instrument = e.target.value; prefs.instrument = e.target.value; savePrefs(); } }),
    h('div', { class: 'row' }, field('Serial no.', E, 'serial'), field('Prism constant (mm)', E, 'prism_constant_mm', { num: true })),
    h('div', { class: 'row' }, field('Target / prism', E, 'target'), field('Calibration date', E, 'calibration_date', { type: 'date' })),
    h('div', { class: 'row' }, field('Level', E, 'level'), field('Staff', E, 'staff')),
    h('div', { class: 'row' }, field('GNSS receiver', E, 'gnss_receiver'), field('Antenna', E, 'gnss_antenna')),
    field('Base station / CORS', E, 'base_station'),
    h('h3', {}, 'Gear checklist'), ...list];
}

// ---- step 3
function step3() {
  const s = S(), T = s.traverse, L = s.levelling, F = s.field;
  const tolBox = h('div', {});
  const drawTol = () => {
    const J = tolData.jurisdictions[s.tolerances.jurisdiction] || tolData.jurisdictions.GENERIC;
    const P = J.profiles[s.tolerances.profile] || J.profiles[J.default];
    const S2 = C.withDefaults(s.settings, tolData);
    const rows = [['Angular', `${C.angularText('n', S2)}`, P.values.ang_k], ['Linear', C.linearText(S2), P.values.ratio], ['Levelling', `${S2.lev_k} mm √K`, P.values.lev_k], ['GNSS', `PDOP ≤ ${S2.pdop_max}, ≥ ${S2.sats_min} sats`, P.values.pdop_max]];
    tolBox.replaceChildren(h('table', {}, h('tr', {}, h('th', {}, 'Check'), h('th', {}, 'Tolerance'), h('th', {}, 'Status')),
      rows.map(([a, b, v]) => h('tr', {}, h('td', {}, a), h('td', {}, b), h('td', {}, tolData.statuses[v.status] || v.status)))),
    h('p', { class: 'hint' }, 'Unverified values are SurveyKit defaults – check them. Change per job on the desktop (Settings).'));
  };
  drawTol();
  const bm = h('div', {});
  const drawBm = () => bm.replaceChildren(...F.benchmarks.map((b, i) => h('div', { class: 'card' },
    h('div', { class: 'row' }, field('BM / mark ID', b, 'id', { caps: true }), field('RL (m)', b, 'rl', { num: true })),
    h('div', { class: 'row' }, field('E', b, 'e', { num: true }), field('N', b, 'n', { num: true })),
    field('Description', b, 'description'), h('button', { class: 'bad', onclick: () => { F.benchmarks.splice(i, 1); changed(); drawBm(); } }, 'Remove'))));
  drawBm();
  return [h('h2', {}, '3 · Known reference'),
    h('label', {}, 'Traverse type'), seg([['closed', 'Closed loop'], ['link', 'Link'], ['open', 'Open']], T.kind, (v) => { T.kind = v; changed(true); }),
    h('label', {}, 'Observe'), seg([['angles', 'Angles'], ['bearings', 'Bearings']], T.mode, (v) => { T.mode = v; changed(true); }),
    field('Start station', T, 'start_station', { caps: true }),
    h('div', { class: 'row' }, field('Start E (m)', T, 'start_e', { num: true, toNumber: true }), field('Start N (m)', T, 'start_n', { num: true, toNumber: true })),
    field(T.kind === 'closed' ? 'Bearing of first leg' : 'Bearing to backsight reference', T, 'start_azimuth', { num: true, help: 'DDD.MMSS', after: angleEcho }),
    T.kind === 'link' ? [h('div', { class: 'row' }, field('End E (m)', T, 'end_e', { num: true, toNumber: true }), field('End N (m)', T, 'end_n', { num: true, toNumber: true })),
      field('Closing bearing', T, 'closing_azimuth', { num: true, help: 'DDD.MMSS', after: angleEcho })] : null,
    h('h3', {}, 'Levelling'),
    h('div', { class: 'row' }, field('Start RL (m)', L, 'start_rl', { num: true, toNumber: true }), field('Closing RL (m)', L, 'close_rl', { num: true, toNumber: true })),
    field('Run length (km)', L, 'length_km', { num: true, toNumber: true }),
    h('h3', {}, 'Benchmarks & marks'), bm, h('button', { onclick: () => { F.benchmarks.push({ id: '', e: '', n: '', rl: '', description: '' }); changed(); drawBm(); } }, '＋ Add benchmark'),
    h('h3', {}, 'Tolerances'),
    select('Jurisdiction', s.tolerances, 'jurisdiction', jurChoices(), { rerender: true, after: (e) => C.applyJurisdiction(s, tolData, e.target.value) }),
    select('Survey type', s.tolerances, 'profile', Object.entries((tolData.jurisdictions[s.tolerances.jurisdiction] || tolData.jurisdictions.GENERIC).profiles).map(([k, p]) => [k, p.label]),
      { rerender: true, after: (e) => C.applyJurisdiction(s, tolData, s.tolerances.jurisdiction, e.target.value) }),
    tolBox,
    field('Reference notes', F, 'reference_notes', { multiline: true })];
}
function angleEcho(e) {
  const v = C.parseAngle(e.target.value);
  let note = e.target.parentElement.querySelector('.hint');
  if (!note) { note = h('div', { class: 'hint' }); e.target.after(note); }
  note.textContent = e.target.value.trim() === '' ? '' : Number.isFinite(v) ? `= ${C.formatBearing(v)}` : '⚠ not a valid angle';
}

// ---- step 4
function step4() {
  const tabs = seg([['traverse', 'Traverse'], ['level', 'Levelling'], ['gnss', 'GNSS']], st.obsTab, (v) => { st.obsTab = v; st.editIdx = null; render(); });
  return [h('h2', {}, '4 · Observations'), tabs, ...(st.obsTab === 'traverse' ? obsTraverse() : st.obsTab === 'level' ? obsLevel() : obsGnss())];
}
function rowEditor(rows, idx, fields, title, onDone) {
  const r = rows[idx];
  return h('div', { class: 'card sel' }, h('b', {}, title),
    fields.map((f) => (f.choices ? select(f.label, r, f.k, f.choices) : field(f.label, r, f.k, { num: f.num, caps: f.caps, help: f.help, after: f.angle ? angleEcho : null }))),
    h('div', { class: 'row' }, h('button', { class: 'ok', onclick: onDone }, '✓ Done'),
      h('button', { class: 'bad', onclick: () => { rows.splice(idx, 1); st.editIdx = null; changed(true); } }, 'Delete row')));
}
function listRows(rows, label, add) {
  return [
    ...rows.map((r, i) => (st.editIdx === i ? null : h('div', { class: 'card', onclick: () => { st.editIdx = i; render(); }, role: 'button', tabindex: 0 }, label(r, i)))),
    st.editIdx === null ? h('button', { class: 'pri', style: 'width:100%', onclick: add }, '＋ Add') : null];
}
function obsTraverse() {
  const s = S(), rows = s.observations, mode = s.traverse.mode;
  const fields = [{ k: 'station', label: 'Station (occupied)', caps: true }, { k: 'bs', label: 'Backsight', caps: true }, { k: 'fs', label: 'Foresight', caps: true },
    mode === 'angles' ? { k: 'h_angle', label: 'Horizontal angle BS→FS', num: true, help: 'DDD.MMSS clockwise', angle: true } : { k: 'bearing', label: 'Bearing', num: true, help: 'DDD.MMSS', angle: true },
    { k: 'distance', label: 'Distance (m)', num: true }, { k: 'dist_type', label: 'Distance type', choices: [['H', 'Horizontal'], ['S', 'Slope']] },
    { k: 'zenith', label: 'Zenith (for slope)', num: true, help: 'DDD.MMSS', angle: true },
    { k: 'hi', label: 'Instrument height HI (m)', num: true }, { k: 'ht', label: 'Target height HT (m)', num: true }, { k: 'code', label: 'Code', caps: true }, { k: 'notes', label: 'Notes' }];
  const out = [];
  if (st.editIdx !== null && rows[st.editIdx]) out.push(rowEditor(rows, st.editIdx, fields, `Row ${st.editIdx + 1}`, () => { st.editIdx = null; render(); }));
  out.push(...listRows(rows, (r, i) => [h('b', {}, `${i + 1}. ${r.station || '?'}`), h('span', {}, `  ${r.bs || '–'} → ${r.fs || '–'}`),
    h('div', { class: 'meta' }, `${mode === 'angles' ? 'angle ' + (r.h_angle || '—') : 'brg ' + (r.bearing || '—')} · ${r.distance || '—'} m ${r.dist_type || 'H'} · HI ${r.hi || '—'} HT ${r.ht || '—'}`)],
  () => { const r = newObsRow(rows[rows.length - 1], options.obs_columns); if (!rows.length && s.traverse.start_station) r.station = s.traverse.start_station; rows.push(r); st.editIdx = rows.length - 1; changed(true); }));
  out.push(h('p', { class: 'hint' }, 'New rows copy HI, HT, distance type and code from the previous row and guess the next station.'));
  return out;
}
function obsLevel() {
  const rows = S().levelling.rows;
  const fields = [{ k: 'station', label: 'Station / point', caps: true }, { k: 'bs', label: 'Backsight BS', num: true }, { k: 'is', label: 'Intermediate IS', num: true },
    { k: 'fs', label: 'Foresight FS', num: true }, { k: 'remark', label: 'Remark' }];
  const out = [];
  if (st.editIdx !== null && rows[st.editIdx]) out.push(rowEditor(rows, st.editIdx, fields, `Reading ${st.editIdx + 1}`, () => { st.editIdx = null; render(); }));
  out.push(...listRows(rows, (r, i) => [h('b', {}, `${i + 1}. ${r.station || '?'}`), h('div', { class: 'meta' }, `BS ${r.bs || '–'} · IS ${r.is || '–'} · FS ${r.fs || '–'} ${r.remark || ''}`)],
    () => { rows.push(newLevelRow(rows[rows.length - 1], options.level_columns)); st.editIdx = rows.length - 1; changed(true); }));
  out.push(h('p', { class: 'hint' }, 'Change point: FS and BS on the same line.'));
  return out;
}
function obsGnss() {
  const rows = S().gnss.points;
  const fields = [{ k: 'id', label: 'Point ID', caps: true }, { k: 'lat', label: 'Latitude (decimal)', num: true }, { k: 'lon', label: 'Longitude (decimal)', num: true },
    { k: 'e', label: 'or Easting (m)', num: true }, { k: 'n', label: 'Northing (m)', num: true }, { k: 'height', label: 'Height (m)', num: true },
    { k: 'ant_h', label: 'Antenna height (m)', num: true }, { k: 'pdop', label: 'PDOP', num: true }, { k: 'sats', label: 'Satellites', num: true },
    { k: 'solution', label: 'Solution', choices: options.solutions.map((x) => [x, x]) }, { k: 'rms_h', label: 'RMS H (m)', num: true }, { k: 'rms_v', label: 'RMS V (m)', num: true },
    { k: 'code', label: 'Code', caps: true }, { k: 'notes', label: 'Notes' }];
  const out = [];
  if (st.editIdx !== null && rows[st.editIdx]) out.push(rowEditor(rows, st.editIdx, fields, `Point ${st.editIdx + 1}`, () => { st.editIdx = null; render(); }),
    h('button', { onclick: () => fillGps(rows[st.editIdx]) }, '📍 Use phone GPS for lat/long'));
  out.push(...listRows(rows, (r) => [h('b', {}, r.id || '?'), h('div', { class: 'meta' }, `${r.lat ? r.lat + ', ' + r.lon : (r.e || '–') + ' / ' + (r.n || '–')} · ${r.solution || '?'} · PDOP ${r.pdop || '–'} · ${r.sats || '–'} sats`)],
    () => { rows.push(newGnssRow(rows[rows.length - 1], options.gnss_columns)); st.editIdx = rows.length - 1; changed(true); }));
  return out;
}
function fillGps(r) {
  if (!navigator.geolocation) return toast('No GPS on this device');
  navigator.geolocation.getCurrentPosition((p) => {
    r.lat = p.coords.latitude.toFixed(8); r.lon = p.coords.longitude.toFixed(8);
    if (p.coords.altitude !== null) r.height = p.coords.altitude.toFixed(2);
    r.solution = 'Autonomous'; r.rms_h = (p.coords.accuracy || 0).toFixed(2); r.notes = (r.notes ? r.notes + '; ' : '') + 'phone GPS (approx.)';
    changed(true); toast('Phone GPS position added (approximate – metres)');
  }, (e) => toast('GPS: ' + e.message), { enableHighAccuracy: true, timeout: 20000 });
}

// ---- step 5
function step5() {
  const s = S(), ids = stationsOf(s);
  if (!st.photoStation || !ids.includes(st.photoStation)) st.photoStation = ids[0] || '';
  const meta = { type: options.photo_types[0], caption: '' };
  const grid = h('div', { class: 'thumbs' });
  for (const p of s.photos[st.photoStation] || []) {
    grid.append(h('figure', {}, h('img', { src: `data:${p.mime || 'image/jpeg'};base64,${p.data_b64}`, alt: `${st.photoStation} ${p.type}` }),
      h('figcaption', {}, h('b', {}, p.type), p.caption ? ' – ' + p.caption : '', h('br'), h('button', { class: 'bad', onclick: () => {
        s.photos[st.photoStation] = s.photos[st.photoStation].filter((x) => x.id !== p.id);
        if (!s.photos[st.photoStation].length) delete s.photos[st.photoStation];
        changed(true);
      } }, 'Delete'))));
  }
  const missing = ids.filter((x) => !(s.photos[x] || []).length);
  return [h('h2', {}, '5 · Photo verification'),
    ids.length ? select('Station / point', st, 'photoStation', ids.map((x) => [x, `${x}${(s.photos[x] || []).length ? ` (${s.photos[x].length})` : ''}`]), { rerender: true }) : h('p', { class: 'big' }, 'Add observations first (step 4).'),
    ids.length ? [select('Photo type', meta, 'type', options.photo_types.map((t) => [t, t])), field('Caption', meta, 'caption'),
      h('label', { class: 'pri', style: 'display:block' }, h('span', { class: 'big' }, '📷 Take / choose photo'),
        h('input', { type: 'file', accept: 'image/*', capture: 'environment', multiple: true, 'aria-label': 'Take photo', onchange: (e) => addPhotos(e.target.files, meta) }))] : null,
    grid,
    missing.length ? h('p', { class: 'hint' }, `No photos yet: ${missing.join(', ')}`) : ids.length ? h('p', { class: 'okc' }, 'Every station has a photo ✓') : null];
}
async function addPhotos(files, meta) {
  for (const f of files) {
    try {
      const { b64, w, hgt } = await shrink(f);
      const id = [...crypto.getRandomValues(new Uint8Array(6))].map((x) => x.toString(16).padStart(2, '0')).join('');
      (S().photos[st.photoStation] ||= []).push({ id, type: meta.type, caption: meta.caption || '', filename: f.name || 'photo.jpg',
        uploaded_at: new Date().toISOString(), mime: 'image/jpeg', width: w, height: hgt, data_b64: b64 });
    } catch (e) { toast('Photo failed: ' + e.message); }
  }
  changed(true);
}
async function shrink(file, max = 1600) {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85));
  return { b64: bytesToB64(new Uint8Array(await blob.arrayBuffer())), w: c.width, hgt: c.height };
}

// ---- step 6
function step6() {
  const s = S();
  const res = C.fieldChecks(s, tolData);
  st.checks = res;
  const cls = res.overall === 'FAIL' ? 'fail' : res.overall === 'PASS' ? 'pass' : 'warn';
  const R = res.run.ok ? res.run.result : null;
  const summary = R ? h('table', {},
    h('tr', {}, h('td', {}, 'Angular misclose'), h('td', {}, R.angular_misclose_sec === null ? 'n/a' : `${R.angular_misclose_sec.toFixed(1)}"`)),
    h('tr', {}, h('td', {}, 'Linear misclose'), h('td', {}, R.linear_misclose === null ? 'n/a' : `${(R.linear_misclose * 1000).toFixed(1)} mm`)),
    h('tr', {}, h('td', {}, 'Precision'), h('td', {}, C.fmtRatio(R.precision_ratio))),
    h('tr', {}, h('td', {}, 'Perimeter'), h('td', {}, `${R.perimeter.toFixed(3)} m`))) : null;
  const wf = { pick: options.workflow_presets[0].id };
  const statusBox = h('div', {});
  drawStatuses(statusBox);
  return [h('h2', {}, '6 · Close & check'),
    h('div', { class: `verdict ${cls}`, role: 'status' }, res.overall),
    h('p', { class: 'hint' }, `${res.counts.pass} pass · ${res.counts.fail} fail · ${res.counts.warn} warn · tolerances: ${s.tolerances.jurisdiction} ${s.tolerances.profile}`),
    summary,
    res.run.warnings.map((w) => h('p', { class: 'hint' }, '⚠ ' + w)),
    h('h3', {}, 'Checks'),
    res.checks.length ? res.checks.map((c) => h('div', { class: 'chk' }, h('b', { class: `s ${c.status}` }, c.status.toUpperCase()),
      h('div', {}, h('b', {}, `${c.area}: ${c.check}`), h('div', { class: 'meta' }, [c.value, c.tolerance && `tol ${c.tolerance}`, c.detail].filter(Boolean).join(' · '))))) : h('p', {}, 'Nothing to check yet.'),
    h('h3', {}, 'Sync'),
    h('p', { role: 'status', class: 'big' }, st.syncMsg || (st.rec.dirty ? 'Changes saved on this phone – not synced yet.' : 'Synced.')),
    h('div', { class: 'row' }, h('button', { class: 'ok', onclick: syncNow, disabled: st.busy }, '⟳ Sync now'), h('button', { onclick: () => download(st.rec) }, '⬇ Project zip')),
    h('h3', {}, 'Run a workflow on the desktop'),
    select('Workflow', wf, 'pick', options.workflow_presets.map((w) => [w.id, w.name])),
    h('button', { class: 'pri', style: 'width:100%', onclick: () => queueWorkflow(wf.pick) }, '▶ Queue on desktop'),
    h('p', { class: 'hint' }, 'Queued here and sent with the next sync; the desktop runs it and the result appears below.'),
    statusBox];
}
async function drawStatuses(box) {
  const out = await store.get('outbox', []);
  const mine = out.filter((o) => o.rec === st.rec.id);
  const cached = st.rec.statuses || [];
  box.replaceChildren(...mine.map((o) => h('div', { class: 'chk' }, h('b', { class: 's info' }, 'OUTBOX'), h('div', {}, o.req.workflow.name, h('div', { class: 'meta' }, 'waiting for sync')))),
    ...cached.slice(0, 6).map((x) => h('div', { class: 'chk' }, h('b', { class: `s ${x.state === 'done' ? 'pass' : x.state === 'failed' ? 'fail' : x.state === 'queued' || x.state === 'running' ? 'info' : 'warn'}` }, String(x.state).toUpperCase().replace('_WITH_ISSUES', '!')),
      h('div', {}, h('b', {}, x.workflow_name), h('div', { class: 'meta' }, `${x.updated_at || ''} ${x.runner_device ? '· ran on ' + x.runner_device : ''}`),
        (x.outputs || []).length ? h('div', { class: 'meta' }, (x.outputs || []).join(', ')) : null,
        (x.steps || []).filter((y) => y.message).map((y) => h('div', { class: 'meta' }, `${y.label}: ${y.message}`))))));
}
async function queueWorkflow(id) {
  const wf = options.workflow_presets.find((w) => w.id === id);
  const out = await store.get('outbox', []);
  out.push({ rec: st.rec.id, req: SY.newRequest(wf, prefs.device_id) });
  await store.set('outbox', out);
  toast('Queued – it will be sent with the next sync');
  if (navigator.onLine && GIS.hasToken()) syncNow(); else render();
}

// --------------------------------------------------------------------------------------------- sync
let adapter = null;
async function getAdapter() {
  if (!GIS.hasToken()) throw Object.assign(new Error('Not connected to Google Drive – ⚙ Settings → Connect.'), { auth: true });
  if (!adapter) { adapter = await new DriveAdapter(GIS.authFetch, prefs.drive_root || null).init(); prefs.drive_root = adapter.rootId; await savePrefs(); }
  return adapter;
}
async function backups(name, bytes) {
  const b = await store.get('backups', []);
  b.unshift({ name, at: new Date().toISOString(), b64: bytesToB64(bytes) });
  await store.set('backups', b.slice(0, 10));
}
export async function syncRecord(rec, ad) {
  const s = rec.session;
  const name = (s.sync || {}).project || N.tryFolderName(s.project, await ad.listProjects())[0];
  const r = await SY.sync(ad, s, name, prefs.device_id, prefs.policy, null, backups);
  rec.session = r.session;
  rec.dirty = r.action === 'retry';
  const out = await store.get('outbox', []);
  const keep = [];
  for (const o of out) { if (o.rec === rec.id && r.action !== 'retry') await SY.enqueue(ad, name, o.req); else keep.push(o); }
  await store.set('outbox', keep);
  rec.statuses = await SY.statuses(ad, name);
  rec.updated_at = new Date().toISOString();
  await store.putProject(rec);
  return r;
}
async function syncNow() {
  if (st.busy) return;
  if (!navigator.onLine) { st.syncMsg = 'Offline – everything is saved on the phone and will sync when you are back online.'; return render(); }
  st.busy = true; render();
  try {
    const r = await syncRecord(st.rec, await getAdapter());
    st.syncMsg = r.message + ` (${new Date().toLocaleTimeString()})`;
    toast(r.message, 3500);
  } catch (e) {
    st.syncMsg = (e.auth ? '' : 'Sync failed – kept on the phone, will retry. ') + e.message;
    if (e.status === 401) { GIS.signOut(); adapter = null; }
  } finally { st.busy = false; render(); }
}
async function autoSync() {
  if (!prefs.auto_sync || !navigator.onLine || !GIS.hasToken() || st.busy) return;
  st.busy = true;
  let redraw = false;
  try {
    const ad = await getAdapter();
    const out = await store.get('outbox', []);
    for (const stored of await store.listProjects()) {
      const open = st.rec && st.rec.id === stored.id;
      const rec = open ? st.rec : stored;                    // never sync a stale copy of the project being edited
      if (!(rec.dirty || out.some((o) => o.rec === rec.id) || (rec.statuses || []).some((x) => ['queued', 'running'].includes(x.state)))) continue;
      const before = JSON.stringify(rec.statuses || []);
      const r = await syncRecord(rec, ad);
      if (open) {
        st.syncMsg = r.message;
        // only redraw when something visible changed – a redraw while typing would steal focus
        redraw ||= !['uploaded', 'up-to-date'].includes(r.action) || JSON.stringify(rec.statuses || []) !== before;
      }
    }
  } catch { /* offline / token expired – try again later */ }
  finally { st.busy = false; }
  const typing = document.activeElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName);
  if (redraw && !(typing && st.step !== 6)) render(); else header();
}
async function connectDrive() {
  try { await GIS.connect(prefs.client_id, true); adapter = null; await getAdapter(); toast('Google Drive connected'); }
  catch (e) { toast(e.message, 5000); }
  render();
}
async function pullFromDrive() {
  try {
    const ad = await getAdapter();
    const names = await ad.listProjects();
    if (!names.length) return toast('No projects in SurveyKit Projects yet');
    const pick = prompt('Project folder to download:\n' + names.join('\n'), names[0]);
    if (!pick || !names.includes(pick)) return;
    const rec = { id: uuid(), session: normalise(newSession(options, prefs), options), dirty: false, updated_at: new Date().toISOString() };
    rec.session.sync = { ...SY.defaultSync(), project: pick, rev: 0 };
    rec.session.sync.content_sha = await SY.contentSha(rec.session);   // "no local edits" → plain download
    await syncRecord(rec, ad);
    rec.session = normalise(rec.session, options);
    await store.putProject(rec);
    openProject(rec.id);
  } catch (e) { toast(e.message, 5000); }
}

// --------------------------------------------------------------------------------------------- projects
async function newProject() {
  const s = newSession(options, prefs);
  C.applyJurisdiction(s, tolData, prefs.jurisdiction || 'QLD');
  if (prefs.instrument) { s.project.instrument = prefs.instrument; s.field.equipment.instrument = prefs.instrument; }
  const existing = (await store.listProjects()).map((r) => (r.session.sync || {}).project || N.tryFolderName(r.session.project, [])[0]);
  s.project.project_no = String(N.nextNumber(existing)).padStart(3, '0');
  const rec = { id: uuid(), session: s, dirty: true, updated_at: new Date().toISOString() };
  await store.putProject(rec);
  openProject(rec.id);
}
async function openProject(id) {
  st.rec = await store.getProject(id);
  st.rec.session = normalise(st.rec.session, options);
  st.view = 'project'; st.step = st.rec.session.field.step || 1; st.editIdx = null; st.syncMsg = '';
  render();
}
async function openZipFile(e) {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const s = normalise(importZip(new Uint8Array(await f.arrayBuffer())), options);
    const rec = { id: uuid(), session: s, dirty: true, updated_at: new Date().toISOString() };
    await store.putProject(rec);
    openProject(rec.id);
    toast(`Opened ${f.name}`);
  } catch (err) { toast(err.message, 5000); }
}
function saveBytes(name, bytes) {
  const a = h('a', { href: URL.createObjectURL(new Blob([bytes], { type: 'application/zip' })), download: name });
  document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
async function download(rec) {
  const name = (rec.session.sync || {}).project || N.tryFolderName(rec.session.project, [])[0];
  const bytes = exportZip(rec.session);
  const file = typeof File === 'function' ? new File([bytes], `${name}.zip`, { type: 'application/zip' }) : null;
  if (file && navigator.canShare && navigator.canShare({ files: [file] })) { try { await navigator.share({ files: [file], title: name }); return; } catch { /* fall back */ } }
  saveBytes(`${name}.zip`, bytes);
}

// --------------------------------------------------------------------------------------------- boot
async function boot() {
  [options, tolData] = await Promise.all(['data/options.json', 'data/tolerances.json'].map((u) => fetch(u).then((r) => r.json())));
  store = openStore();
  prefs = { surveyor: '', datum: 'EPSG:7856', jurisdiction: 'QLD', client_id: '', policy: 'lww', auto_sync: true, device_id: '', drive_root: '', instrument: '', ...(await store.get('prefs', {})) };
  if (!prefs.device_id) { prefs.device_id = 'phone-' + uuid().slice(0, 8); await savePrefs(); }
  gear = await store.get('gear', ['Total station', 'Tripod', 'Prism + pole', 'GNSS rover', 'Level + staff', 'Tape', 'Marks / pegs', 'Hammer', 'Spray paint']);
  $('#home').addEventListener('click', () => { st.view = 'list'; st.rec = null; render(); });
  addEventListener('online', () => { header(); autoSync(); });
  addEventListener('offline', header);
  setInterval(autoSync, 60000);
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  render();
  globalThis.SK = { st, store, C, N, SY, syncRecord, newProject, version: VERSION };
  addEventListener("unhandledrejection", (e) => { console.error(e.reason); toast("Error: " + (e.reason && e.reason.message || e.reason), 6000); });   // for debugging / browser QA
}
if (globalThis.document) boot();
