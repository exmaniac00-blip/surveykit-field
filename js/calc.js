// SurveyKit calculations – JavaScript port of surveykit/calculations.py, workflow.py (traverse build),
// gnss.py (quality flags) and tolerances.py / qaqc.py (checks). Tested against Python results on the same
// samples (test/calc.test.mjs ← data/fixtures.json from scripts/export_shared.py).
const D2R = Math.PI / 180;

export function norm360(deg) {
  let r = deg % 360;
  if (r < 0) r += 360;
  if (Math.abs(r - 360) < 1e-12 || Math.abs(r) < 1e-12) r = 0;
  return r;
}
export const wrap180 = (deg) => { const r = norm360(deg); return r > 180 ? r - 360 : r; };
const dms = (d, m, s, sign) => sign * (Math.abs(d) + m / 60 + s / 3600);

export function parseAngle(value) {
  if (value === null || value === undefined) return NaN;
  if (typeof value === 'number' && Number.isNaN(value)) return NaN;
  let s = String(value).trim();
  if (!s) return NaN;
  let sign = 1;
  if (s[0] === '+' || s[0] === '-') { sign = s[0] === '-' ? -1 : 1; s = s.slice(1).trim(); }
  if (/^\d+(\.\d*)?$/.test(s)) {
    const [dpart, fpart = ''] = s.split('.');
    const f = (fpart + '0000').slice(0, Math.max(4, fpart.length));
    const d = parseInt(dpart, 10), m = parseInt(f.slice(0, 2), 10);
    const sec = parseFloat(f.slice(2, 4) + '.' + (f.slice(4) || '0'));
    if (m >= 60 || sec >= 60) return NaN;
    return dms(d, m, sec, sign);
  }
  const parts = s.replace(/[^\d.]+/g, ' ').split(' ').filter(Boolean);
  if (!parts.length || parts.length > 3 || !parts.every((p) => /^\d+(\.\d+)?$/.test(p))) return NaN;
  const nums = parts.map(Number);
  if (nums.length === 1) return sign * nums[0];
  const [d, m] = nums, sec = nums.length === 3 ? nums[2] : 0;
  if (m >= 60 || sec >= 60 || (nums.length === 3 && !Number.isInteger(m))) return NaN;
  return dms(d, m, sec, sign);
}

export function formatDms(deg, dp = 0, pad = 0, wrap = false) {
  if (deg === null || deg === undefined || !Number.isFinite(deg)) return '';
  const sign = deg < 0 ? '-' : '';
  const f = 10 ** dp;
  const x = Math.abs(deg) * 3600 * f;
  let tot = Math.round(x);
  if (x - Math.floor(x) === 0.5 && tot % 2 === 1) tot -= 1;      // Python round(): half to even
  let d = Math.floor(tot / (3600 * f)); tot -= d * 3600 * f;
  const m = Math.floor(tot / (60 * f)); tot -= m * 60 * f;
  if (wrap && d >= 360) d -= 360;
  const s = (tot / f).toFixed(dp).padStart(dp ? 3 + dp : 2, '0');
  return `${sign}${String(d).padStart(pad, '0')}°${String(m).padStart(2, '0')}'${s}"`;
}
export const formatBearing = (deg, dp = 0) => (deg === null || !Number.isFinite(deg) ? '' : formatDms(norm360(deg), dp, 3, true));

export function reduceSlope(sd, zenith, hi = 0, ht = 0) {
  if (zenith === null || zenith === undefined || !Number.isFinite(zenith)) return { hd: sd, vd: 0, dh: 0 };
  const z = zenith * D2R, hd = sd * Math.sin(z), vd = sd * Math.cos(z);
  return { hd, vd, dh: vd + (hi || 0) - (ht || 0) };
}

export function join(e1, n1, e2, n2) {
  const de = e2 - e1, dn = n2 - n1, dist = Math.hypot(de, dn);
  return { dE: de, dN: dn, dist, bearing: dist > 0 ? norm360(Math.atan2(de, dn) / D2R) : NaN };
}

// ------------------------------------------------------------------------------------------- field book rows
const blank = (v) => v === null || v === undefined || (typeof v === 'number' && Number.isNaN(v)) || String(v).trim() === '';
export function num(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isNaN(v) ? null : v;
  const s = String(v).trim();
  if (!s) return null;
  const x = Number(s);
  return Number.isNaN(x) ? NaN : x;
}

export function validateRow(r, i, mode, needDist = true) {
  const errs = [], out = {};
  const tag = `Row ${i + 1}` + (!blank(r.station) ? ` (${r.station})` : '');
  if (blank(r.station)) errs.push(`${tag}: station ID is required.`);
  if (mode === 'angles') {
    const a = parseAngle(r.h_angle);
    if (blank(r.h_angle)) out.angle = null;
    else if (!Number.isFinite(a) || a < 0 || a >= 360) errs.push(`${tag}: horizontal angle '${r.h_angle}' is not a valid angle in 0–360° (use DDD.MMSS or D M S).`);
    else out.angle = a;
  } else {
    const b = parseAngle(r.bearing);
    if (blank(r.bearing)) { if (needDist) errs.push(`${tag}: bearing is required in bearing mode.`); }
    else if (!Number.isFinite(b) || b < 0 || b >= 360) errs.push(`${tag}: bearing '${r.bearing}' is not valid in 0–360°.`);
    else out.azimuth = b;
  }
  let z = null;
  if (!blank(r.zenith)) {
    z = parseAngle(r.zenith);
    if (!Number.isFinite(z) || z <= 0 || z >= 180) { errs.push(`${tag}: zenith angle '${r.zenith}' must be between 0° and 180°.`); z = null; }
  }
  out.zenith = z;
  for (const k of ['hi', 'ht']) {
    let v = num(r[k]);
    if (v !== null && (Number.isNaN(v) || v < 0)) { errs.push(`${tag}: ${k.toUpperCase()} must be a number ≥ 0.`); v = null; }
    out[k] = v;
  }
  const d = num(r.distance);
  const dt = (String(r.dist_type || 'H').trim().toUpperCase().slice(0, 1)) || 'H';
  if (dt !== 'H' && dt !== 'S') errs.push(`${tag}: distance type must be H (horizontal) or S (slope).`);
  if (d === null) { if (needDist) errs.push(`${tag}: distance is required.`); out.hd = null; }
  else if (Number.isNaN(d) || d <= 0) { errs.push(`${tag}: distance must be a positive number of metres.`); out.hd = null; }
  else if (dt === 'S') {
    if (z === null) { errs.push(`${tag}: a slope distance needs a zenith angle to reduce to horizontal.`); out.hd = null; }
    else { const red = reduceSlope(d, z, out.hi || 0, out.ht || 0); Object.assign(out, { hd: red.hd, vd: red.vd, dh: red.dh, sd: d }); }
  } else out.hd = d;
  return [errs, out];
}

function controlPoint(session, field) {
  // GNSS points typed with E/N (the phone does not project lat/long; the desktop does)
  const k = String((session.traverse || {})[field] || '');
  if (!k) return null;
  const id = k.includes(':') ? k.split(':').slice(1).join(':') : k;
  for (const p of (session.gnss || {}).points || []) {
    if (String(p.id || '').trim() === id) {
      const e = num(p.e), n = num(p.n);
      if (e !== null && n !== null && !Number.isNaN(e) && !Number.isNaN(n)) return { e, n, rl: num(p.height) };
    }
  }
  for (const p of (session.imported || {}).points || []) {
    if (String(p.id || '').trim() === id) {
      const e = num(p.e), n = num(p.n);
      if (e !== null && n !== null && !Number.isNaN(e) && !Number.isNaN(n)) return { e, n, rl: num(p.z) };
    }
  }
  return null;
}

export function buildTraverse(session) {
  const T = session.traverse;
  const rows = (session.observations || []).filter((r) => Object.values(r).some((v) => !blank(v)));
  const kind = T.kind || 'closed', mode = T.mode || 'angles';
  const errors = [], warnings = [];
  if (!rows.length) return [null, ['Enter at least one observation row.'], []];
  const reduced = rows.map((r, i) => {
    const need = !(i === rows.length - 1 && kind !== 'closed');
    const [e, red] = validateRow(r, i, mode, need);
    errors.push(...e);
    return red;
  });
  const stations = rows.map((r) => String(r.station ?? '').trim());
  const seen = new Set();
  for (const s of stations) { if (s && seen.has(s)) errors.push(`Station '${s}' appears more than once in the traverse.`); seen.add(s); }
  rows.slice(0, -1).forEach((r, i) => {
    const fs = String(r.fs || '').trim();
    if (fs && fs !== stations[i + 1]) warnings.push(`Row ${i + 1}: FS '${fs}' does not match the next station '${stations[i + 1]}'.`);
  });
  if (kind === 'closed' && !['', stations[0]].includes(String(rows[rows.length - 1].fs || '').trim()))
    warnings.push(`Closed traverse: last FS '${rows[rows.length - 1].fs}' should be the start station '${stations[0]}'.`);
  const hds = reduced.map((r) => (r.hd === undefined ? null : r.hd));
  if (kind !== 'closed' && hds[hds.length - 1] !== null) {
    const fs = String(rows[rows.length - 1].fs || '').trim();
    if (!fs) errors.push('Last row has a distance but no FS point ID.');
    else { stations.push(fs); reduced.push({ angle: null, hd: null }); }
  }
  let se, sn;
  const sp = controlPoint(session, 'start_control');
  if (T.start_control && !sp) errors.push(`Start control point '${T.start_control}' was not found (or has no E/N).`);
  if (sp) { se = sp.e; sn = sp.n; } else { se = num(T.start_e); sn = num(T.start_n); }
  if (se === null || sn === null || Number.isNaN(se) || Number.isNaN(sn)) errors.push('Start coordinates (E, N) are required.');
  const startAz = !blank(T.start_azimuth) ? parseAngle(T.start_azimuth) : null;
  if (mode === 'angles' && (startAz === null || !Number.isFinite(startAz)))
    errors.push('A valid starting azimuth is required (closed: bearing of first leg; link/open: bearing to the backsight reference).');
  let closeAz = null, ee = null, en = null;
  if (kind === 'link') {
    const ep = controlPoint(session, 'end_control');
    if (T.end_control && !ep) errors.push(`Closing control point '${T.end_control}' was not found (or has no E/N).`);
    if (ep) { ee = ep.e; en = ep.n; } else { ee = num(T.end_e); en = num(T.end_n); }
    if (ee === null || en === null || Number.isNaN(ee) || Number.isNaN(en)) errors.push('Link traverse: known end coordinates (E, N) are required.');
    if (!blank(T.closing_azimuth)) {
      closeAz = parseAngle(T.closing_azimuth);
      if (!Number.isFinite(closeAz)) { errors.push('Closing azimuth is not a valid angle.'); closeAz = null; }
    } else if (mode === 'angles') warnings.push('No closing azimuth – angular misclose cannot be checked.');
  }
  if (kind === 'open') warnings.push('Open traverse: there is no independent check on angles or coordinates.');
  if (errors.length) return [null, errors, warnings];
  const nlegs = kind === 'closed' ? stations.length : stations.length - 1;
  const ti = {
    kind, stations, hds: hds.slice(0, nlegs),
    angles: mode === 'angles' ? reduced.map((r) => (r.angle === undefined ? null : r.angle)) : null,
    azimuths: mode === 'bearings' ? reduced.map((r) => (r.azimuth === undefined ? null : r.azimuth)).slice(0, nlegs) : null,
    start_e: se, start_n: sn, start_azimuth: startAz, end_e: ee, end_n: en, closing_azimuth: closeAz,
    method: T.method || 'bowditch', adjust_angles: T.adjust_angles === undefined ? true : !!T.adjust_angles,
  };
  if (ti.hds.some((h) => h === null || h === undefined)) return [null, ['A distance is required for every leg.'], warnings];
  return [ti, errors, warnings];
}

const legsFromAngles = (first, angles) => { const az = [first]; for (const a of angles) az.push(norm360(az[az.length - 1] + 180 + a)); return az; };
const cumsum = (a) => { let s = 0; return a.map((x) => (s += x)); };
const sum = (a) => a.reduce((x, y) => x + y, 0);

export function computeTraverse(t) {
  const n = t.stations.length, kind = t.kind;
  if (kind === 'closed') {
    if (n < 3) throw new Error('A closed loop traverse needs at least 3 stations.');
    if (t.hds.length !== n) throw new Error('Closed traverse: one distance per station (last leg returns to the start).');
  } else {
    if (n < 2) throw new Error('A link/open traverse needs at least 2 stations.');
    if (t.hds.length < n - 1) throw new Error('Link/open traverse: a distance is needed for every leg.');
  }
  const bearingMode = t.angles === null || t.angles === undefined;
  const out = { kind, n_stations: n, method: t.method, mode: bearingMode ? 'bearings' : 'angles' };
  const nlegs = kind === 'closed' ? n : n - 1;
  const hds = t.hds.slice(0, nlegs);
  let angMis = null, corr = 0, adj = null, az;
  if (bearingMode) {
    if (!t.azimuths || t.azimuths.length < nlegs) throw new Error('Bearing mode: a bearing is required for every leg.');
    az = t.azimuths.slice(0, nlegs).map(norm360);
  } else {
    let ang = t.angles.slice();
    const need = (kind === 'closed' || (kind === 'link' && t.closing_azimuth !== null && t.closing_azimuth !== undefined)) ? n : n - 1;
    if (ang.length < need || ang.slice(0, need).some((a) => a === null || !Number.isFinite(a))) throw new Error(`Angle mode: an observed angle is required at ${need} station(s).`);
    ang = ang.map((a) => (a === null ? 0 : a));
    while (ang.length < n) ang.push(0);
    if (t.start_azimuth === null || t.start_azimuth === undefined) throw new Error('A starting azimuth is required.');
    if (kind === 'closed') {
      const s = sum(ang.slice(0, n));
      const interior = Math.abs(s - (n - 2) * 180) <= Math.abs(s - (n + 2) * 180);
      const expected = interior ? (n - 2) * 180 : (n + 2) * 180;
      angMis = wrap180(s - expected);
      Object.assign(out, { sum_angles: s, expected_sum: expected, angle_set: interior ? 'interior' : 'exterior' });
      corr = t.adjust_angles ? -angMis / n : 0;
      adj = ang.map((a) => a + corr);
      az = legsFromAngles(norm360(t.start_azimuth), adj.slice(1)).slice(0, nlegs);
      out.closing_check_azimuth = norm360(az[az.length - 1] + 180 + adj[0]);
    } else {
      let first = norm360(t.start_azimuth + ang[0]);
      const azRaw = n > 1 ? legsFromAngles(first, ang.slice(1, n - 1)) : [first];
      if (kind === 'link' && t.closing_azimuth !== null && t.closing_azimuth !== undefined) {
        const comp = n >= 2 ? norm360(azRaw[azRaw.length - 1] + 180 + ang[n - 1]) : first;
        angMis = wrap180(comp - t.closing_azimuth);
        out.computed_closing_azimuth = comp;
        corr = t.adjust_angles ? -angMis / n : 0;
      }
      adj = ang.map((a) => a + corr);
      first = norm360(t.start_azimuth + adj[0]);
      az = legsFromAngles(first, adj.slice(1, n - 1)).slice(0, nlegs);
    }
  }
  Object.assign(out, { angular_misclose: angMis, angular_misclose_sec: angMis === null ? null : angMis * 3600,
    angle_correction_sec: corr * 3600, adjusted_angles: adj });
  const lat = az.map((a, i) => hds[i] * Math.cos(a * D2R));
  const dep = az.map((a, i) => hds[i] * Math.sin(a * D2R));
  const eUn = cumsum(dep).map((x) => t.start_e + x), nUn = cumsum(lat).map((x) => t.start_n + x);
  let endE = null, endN = null;
  if (kind === 'closed') { endE = t.start_e; endN = t.start_n; } else if (kind === 'link') {
    if (t.end_e === null || t.end_n === null) throw new Error('Link traverse: known end coordinates are required.');
    endE = t.end_e; endN = t.end_n;
  }
  const total = sum(hds);
  const res = { azimuths: az, hds, lat, dep, sum_lat: sum(lat), sum_dep: sum(dep), perimeter: total };
  let ce, cn;
  if (endE !== null) {
    const misE = eUn[eUn.length - 1] - endE, misN = nUn[nUn.length - 1] - endN;
    const lin = Math.hypot(misE, misN);
    Object.assign(res, { misclose_e: misE, misclose_n: misN, linear_misclose: lin, precision_ratio: lin < 1e-9 ? Infinity : total / lin,
      misclose_bearing: lin > 0 ? norm360(Math.atan2(misE, misN) / D2R) : NaN });
    if (t.method === 'bowditch') { ce = hds.map((d) => -misE * d / total); cn = hds.map((d) => -misN * d / total); }
    else if (t.method === 'transit') {
      const sa = sum(dep.map(Math.abs)), sl = sum(lat.map(Math.abs));
      ce = dep.map((x) => (sa > 0 ? -misE * Math.abs(x) / sa : 0)); cn = lat.map((x) => (sl > 0 ? -misN * Math.abs(x) / sl : 0));
    } else { ce = hds.map(() => 0); cn = hds.map(() => 0); }
  } else {
    Object.assign(res, { misclose_e: null, misclose_n: null, linear_misclose: null, precision_ratio: null });
    ce = hds.map(() => 0); cn = hds.map(() => 0); out.method = 'none';
  }
  const eAdj = cumsum(dep.map((x, i) => x + ce[i])).map((x) => t.start_e + x);
  const nAdj = cumsum(lat.map((x, i) => x + cn[i])).map((x) => t.start_n + x);
  const to = [...Array(nlegs).keys()].map((i) => t.stations[(i + 1) % n]);
  const legs = [];
  let pe = t.start_e, pn = t.start_n;
  for (let i = 0; i < nlegs; i++) {
    const j = join(pe, pn, eAdj[i], nAdj[i]);
    legs.push({ from: t.stations[i], to: to[i], azimuth: az[i], hd: hds[i], lat: lat[i], dep: dep[i], corr_lat: cn[i], corr_dep: ce[i],
      adj_lat: lat[i] + cn[i], adj_dep: dep[i] + ce[i], adj_azimuth: j.bearing, adj_hd: j.dist, corr_len: Math.hypot(ce[i], cn[i]) });
    pe = eAdj[i]; pn = nAdj[i];
  }
  const coords = [{ station: t.stations[0], unadj_e: t.start_e, unadj_n: t.start_n, adj_e: t.start_e, adj_n: t.start_n, corr_e: 0, corr_n: 0 }];
  const ceC = cumsum(ce), cnC = cumsum(cn);
  for (let i = 0; i < nlegs; i++) {
    if (kind === 'closed' && i === nlegs - 1) break;
    coords.push({ station: to[i], unadj_e: eUn[i], unadj_n: nUn[i], adj_e: eAdj[i], adj_n: nAdj[i], corr_e: ceC[i], corr_n: cnC[i] });
  }
  if (kind === 'closed') res.closing_point = { unadj_e: eUn[eUn.length - 1], unadj_n: nUn[nUn.length - 1], adj_e: eAdj[eAdj.length - 1], adj_n: nAdj[nAdj.length - 1] };
  return Object.assign(out, res, { legs, coords });
}

export function runTraverse(session) {
  const [ti, errors, warnings] = buildTraverse(session);
  if (!ti) return { ok: false, result: null, errors, warnings };
  try { return { ok: true, result: computeTraverse(ti), errors: [], warnings }; }
  catch (e) { return { ok: false, result: null, errors: [e.message], warnings }; }
}

// ------------------------------------------------------------------------------------------- levelling
const lnum = (v) => { const x = num(v); return x === null || Number.isNaN(x) ? null : x; };
export function reduceLevels(rows, startRl, closeRl = null) {
  const R = rows.map((r) => ({ station: r.station ?? '', bs: lnum(r.bs), is: lnum(r.is), fs: lnum(r.fs), remark: r.remark ?? '' }));
  const errors = [];
  if (!R.length) return { ok: false, errors: ['No readings'], rows: [] };
  if (R[0].bs === null) errors.push('The first reading must be a backsight (BS).');
  R.slice(1).forEach((r, k) => {
    const i = k + 2;
    if (r.is !== null && (r.bs !== null || r.fs !== null)) errors.push(`Row ${i}: an IS cannot share a line with a BS or FS.`);
    if (r.bs === null && r.is === null && r.fs === null) errors.push(`Row ${i}: no reading.`);
    if (r.bs !== null && r.fs === null) errors.push(`Row ${i}: a BS after the first line must be booked with an FS (change point).`);
  });
  if (R.length > 1 && R[R.length - 1].fs === null) errors.push('The last reading should be a foresight (FS).');
  if (errors.length) return { ok: false, errors, rows: R };
  let prev = null, hpc = null, rl = startRl, setup = 0, sBs = 0, sIs = 0, sFs = 0, sRise = 0, sFall = 0, hpcSum = 0;
  R.forEach((r, i) => {
    r.rise = r.fall = r.hpc = null;
    if (i === 0) { r.rl_rf = r.rl_hpc = startRl; r.setup = 0; } else {
      const reading = r.is !== null ? r.is : r.fs;
      const diff = prev - reading;
      if (diff >= 0) { r.rise = diff; sRise += diff; } else { r.fall = -diff; sFall -= diff; }
      rl += diff; r.rl_rf = rl; r.rl_hpc = hpc - reading; hpcSum += hpc; r.setup = setup;
      if (r.is !== null) sIs += r.is; else sFs += r.fs;
      prev = reading;
    }
    if (r.bs !== null) { sBs += r.bs; prev = r.bs; setup += 1; hpc = r.rl_hpc + r.bs; r.hpc = hpc; }
  });
  const last = R[R.length - 1].rl_rf, sRl = sum(R.slice(1).map((r) => r.rl_hpc)), eps = 1e-6;
  const c = { sum_bs: sBs, sum_is: sIs, sum_fs: sFs, sum_rise: sRise, sum_fall: sFall, bs_minus_fs: sBs - sFs,
    rise_minus_fall: sRise - sFall, last_minus_first: last - startRl, hpc_lhs: hpcSum - sIs - sFs, hpc_rhs: sRl };
  c.rf_ok = Math.abs(c.bs_minus_fs - c.rise_minus_fall) < eps && Math.abs(c.rise_minus_fall - c.last_minus_first) < eps;
  c.hpc_ok = Math.abs(c.hpc_lhs - c.hpc_rhs) < eps * Math.max(1, R.length);
  c.methods_agree = R.every((r) => Math.abs(r.rl_rf - r.rl_hpc) < eps);
  const mis = closeRl === null || closeRl === undefined ? null : last - closeRl;
  for (const r of R) { r.corr = mis === null || setup === 0 ? 0 : -mis * r.setup / setup; r.rl_adj = r.rl_rf + r.corr; }
  return { ok: true, errors: [], rows: R, setups: setup, checks: c, misclose: mis };
}

function levelEnds(session) {
  // start/closing RL typed, or from a benchmark ID (GNSS/imported point with height) – the typed value wins
  const L = session.levelling || {};
  return [lnum(L.start_rl), lnum(L.close_rl)];
}
export function levelResult(session) {
  const L = session.levelling || {};
  const [s, c] = levelEnds(session);
  if (!(L.rows || []).length || s === null) return null;
  return reduceLevels(L.rows, s, c);
}

// ------------------------------------------------------------------------------------------- GNSS flags
export const GNSS_DEFAULTS = { pdop_max: 4.0, sats_min: 6, rms_h_max: 0.05, rms_v_max: 0.08 };
const ORTHO = ['AHD', 'EPSG:5711', 'EPSG:7841', 'EPSG:5714', 'EPSG:3855', 'LOCAL_MSL'];
export function normSolution(v) {
  const s = String(v ?? '').trim().toLowerCase();
  for (const [k, o] of [['fix', 'Fixed'], ['rtk', 'Fixed'], ['float', 'Float'], ['flt', 'Float'], ['dgps', 'DGPS'], ['dgnss', 'DGPS'],
    ['sbas', 'DGPS'], ['diff', 'DGPS'], ['auto', 'Autonomous'], ['single', 'Autonomous'], ['standalone', 'Autonomous'], ['nav', 'Autonomous']])
    if (s.includes(k)) return o;
  return { 4: 'Fixed', 5: 'Float', 2: 'DGPS', 1: 'Autonomous' }[s] || String(v ?? '').trim();
}
const g = (x) => String(Number(x.toPrecision(6)));   // Python :g
export function gnssResolve(session) {
  const G = session.gnss || {};
  const S = { ...GNSS_DEFAULTS };
  for (const k of Object.keys(GNSS_DEFAULTS)) if ((session.settings || {})[k] !== undefined) S[k] = session.settings[k];
  const rows = (G.points || []).filter((r) => Object.values(r).some((v) => String(v ?? '').trim()));
  const ids = rows.map((r) => String(r.id ?? '').trim());
  const vert = (session.datum || {}).vertical;
  return rows.map((r, i) => {
    const pid = ids[i];
    const p = { id: pid, errors: [], flags: [] };
    const tag = `GNSS row ${i + 1}` + (pid ? ` (${pid})` : '');
    if (!pid) p.errors.push(`${tag}: point ID is required.`);
    else if (ids.filter((x) => x === pid).length > 1) p.flags.push('duplicate ID');
    const latT = String(r.lat ?? '').trim(), lonT = String(r.lon ?? '').trim();
    const e = num(r.e), n = num(r.n);
    if (latT || lonT) {
      const la = Number(latT), lo = Number(lonT);
      if (!(Number.isFinite(la) && Number.isFinite(lo) && la >= -90 && la <= 90 && lo >= -180 && lo <= 180))
        p.errors.push(`${tag}: latitude/longitude '${latT}', '${lonT}' are not valid (decimal degrees on the phone)`);
      else { p.lat = la; p.lon = lo; }
    } else if (e !== null && n !== null) {
      if (Number.isNaN(e) || Number.isNaN(n)) p.errors.push(`${tag}: E/N must be numbers`); else { p.e = e; p.n = n; }
    } else p.errors.push(`${tag}: enter latitude/longitude or E/N`);
    const hgt = num(r.height), ah = num(r.ant_h);
    if (hgt !== null && !Number.isNaN(hgt)) {
      if (G.height_type === 'ellipsoidal' && ORTHO.includes(vert) && !G.geoid_n) p.flags.push('geoid N not set – RL equals the ellipsoidal height');
    } else if (hgt !== null) p.errors.push(`${tag}: height must be a number.`);
    if (ah === null || Number.isNaN(ah)) p.flags.push('missing antenna height');
    const pdop = num(r.pdop), sats = num(r.sats);
    if (pdop !== null && !Number.isNaN(pdop) && pdop > S.pdop_max) p.flags.push(`PDOP ${g(pdop)} > ${g(S.pdop_max)}`);
    if (sats !== null && !Number.isNaN(sats) && sats < S.sats_min) p.flags.push(`${g(sats)} satellites < ${g(S.sats_min)}`);
    const sol = normSolution(r.solution);
    if (['Float', 'Autonomous', 'DGPS'].includes(sol)) p.flags.push(`${sol} solution`);
    else if (!sol) p.flags.push('solution type not recorded');
    for (const [k, lim, lab] of [['rms_h', 'rms_h_max', 'H'], ['rms_v', 'rms_v_max', 'V']]) {
      const v = num(r[k]);
      if (v !== null && !Number.isNaN(v) && v > S[lim]) p.flags.push(`RMS ${lab} ${v.toFixed(3)} m > ${Number(S[lim]).toFixed(3)} m`);
    }
    p.solution = sol;
    p.flagged = p.flags.length > 0 || p.errors.length > 0;
    return p;
  });
}

// ------------------------------------------------------------------------------------------- tolerances
export function tolValues(tolData, jur, prof) {
  const J = tolData.jurisdictions[jur] || tolData.jurisdictions.GENERIC;
  const P = J.profiles[prof] || J.profiles[J.default];
  return Object.fromEntries(Object.entries(P.values).map(([k, v]) => [k, v.value]));
}
export function withDefaults(settings, tolData) {
  return { ...tolValues(tolData, 'GENERIC'), ...settings };
}
export function applyJurisdiction(session, tolData, jur, prof) {
  const J = tolData.jurisdictions[jur] || tolData.jurisdictions.GENERIC;
  const p = J.profiles[prof] ? prof : J.default;
  session.tolerances = { jurisdiction: tolData.jurisdictions[jur] ? jur : 'GENERIC', profile: p };
  Object.assign(session.settings, tolValues(tolData, session.tolerances.jurisdiction, p));
  return session;
}
export function angularTol(n, s) {
  const t = Number(s.ang_const) + Number(s.ang_k) * Math.sqrt(Math.max(n, 0));
  const cap = Number(s.ang_cap || 0);
  return cap > 0 ? Math.min(t, cap) : t;
}
const fmtG = (x) => g(Number(x));
const thousands = (x) => Math.round(Number(x)).toLocaleString('en-AU');
export function angularText(n, s) {
  return (s.ang_const ? `${fmtG(s.ang_const)}" + ` : '') + `${fmtG(s.ang_k)}"√${n}` + (s.ang_cap ? `, max ${fmtG(s.ang_cap)}"` : '');
}
export function linearTol(L, s) {
  const c = Number(s.lin_const_mm || 0) / 1000;
  const r = Number(s.ratio || 0) > 0 ? L / Number(s.ratio) : Infinity;
  return s.lin_mode === 'max' ? Math.max(c, r) : c + r;
}
export function linearText(s) {
  if (!s.lin_const_mm) return `1 : ${thousands(s.ratio)}`;
  const j = s.lin_mode === 'max' ? ' or ' : ' + ';
  return `${fmtG(s.lin_const_mm)} mm${j}1 : ${thousands(s.ratio)} of length` + (s.lin_mode === 'max' ? ' (greater)' : '');
}
export const levellingTol = (km, s) => Number(s.lev_k) * Math.sqrt(Math.max(km, 0));
export const fmtRatio = (r) => (r === null || r === undefined ? 'n/a' : !Number.isFinite(r) ? '1 : ∞ (no misclose)' : `1 : ${thousands(r)}`);

const C = (area, check, status, value = '', tolerance = '', detail = '') => ({ area, check, status, value, tolerance, detail });
const sgn = (x, dp) => (x >= 0 ? '+' : '') + x.toFixed(dp);

export function traverseChecks(result, settings, tolData) {
  const out = [], n = result.n_stations, S = withDefaults(settings, tolData);
  if (result.angular_misclose_sec !== null && result.angular_misclose_sec !== undefined) {
    const tol = angularTol(n, S), am = result.angular_misclose_sec;
    out.push(C('Traverse', 'Angular misclose', Math.abs(am) <= tol + 1e-6 ? 'pass' : 'fail', `${sgn(am, 1)}"`, `±${tol.toFixed(1)}" (${angularText(n, S)})`));
  } else if (result.mode === 'angles') out.push(C('Traverse', 'Angular misclose', 'warn', '', '', 'Not checkable (open traverse or no closing azimuth).'));
  else out.push(C('Traverse', 'Angular misclose', 'info', '', '', 'Bearing mode – bearings used as given; no angular check.'));
  const ratio = result.precision_ratio;
  if (ratio !== null && ratio !== undefined) {
    if (!S.lin_const_mm) {
      out.push(C('Traverse', 'Precision ratio', ratio >= S.ratio ? 'pass' : 'fail', `${fmtRatio(ratio)} (linear ${(result.linear_misclose * 1000).toFixed(1)} mm)`, `≥ 1 : ${thousands(S.ratio)}`));
    } else {
      const L = Number(result.perimeter || sum(result.legs.map((l) => l.hd)));
      const tl = linearTol(L, S), lin = result.linear_misclose;
      out.push(C('Traverse', 'Linear misclose', lin <= tl + 1e-9 ? 'pass' : 'fail', `${(lin * 1000).toFixed(1)} mm (${fmtRatio(ratio)})`,
        `≤ ${(tl * 1000).toFixed(1)} mm (${linearText(S)}, L = ${L.toFixed(1)} m)`));
    }
    for (const lg of result.legs)
      if (lg.hd > 0 && lg.corr_len > 0 && lg.hd / lg.corr_len < S.ratio)
        out.push(C('Traverse', `Leg ${lg.from}→${lg.to} correction`, 'warn', `${(lg.corr_len * 1000).toFixed(1)} mm on ${lg.hd.toFixed(3)} m (1:${thousands(lg.hd / lg.corr_len)})`,
          `≥ 1 : ${thousands(S.ratio)}`, 'Large correction relative to the leg length – check this leg.'));
  } else out.push(C('Traverse', 'Linear misclose', 'warn', '', '', 'Open traverse – no coordinate check.'));
  for (const lg of result.legs) {
    if (lg.hd < S.short_leg) out.push(C('Observations', `Leg ${lg.from}→${lg.to}`, 'warn', `${lg.hd.toFixed(3)} m`, `≥ ${fmtG(S.short_leg)} m`, 'Very short leg – centring errors dominate angles.'));
    if (lg.hd > S.long_leg) out.push(C('Observations', `Leg ${lg.from}→${lg.to}`, 'warn', `${lg.hd.toFixed(3)} m`, `≤ ${fmtG(S.long_leg)} m`, 'Very long leg – check distance/units.'));
  }
  return out;
}

export function levellingChecks(res, lengthKm, settings, tolData) {
  if (!res) return [];
  if (!res.ok) return res.errors.map((e) => C('Levelling', 'Booking', 'fail', '', '', e));
  const c = res.checks, S = withDefaults(settings, tolData);
  const out = [
    C('Levelling', 'Arithmetic check (rise & fall)', c.rf_ok ? 'pass' : 'fail', `ΣBS−ΣFS ${c.bs_minus_fs.toFixed(3)} = ΣR−ΣF ${c.rise_minus_fall.toFixed(3)} = Last−First ${c.last_minus_first.toFixed(3)}`),
    C('Levelling', 'Arithmetic check (HPC)', c.hpc_ok ? 'pass' : 'fail', `Σ(HPC×n)−ΣIS−ΣFS ${c.hpc_lhs.toFixed(3)} = ΣRL ${c.hpc_rhs.toFixed(3)}`),
  ];
  const km = lnum(lengthKm);
  if (res.misclose === null) out.push(C('Levelling', 'Misclose', 'warn', '', '', 'No closing RL – misclose not tested.'));
  else if (!km || km <= 0) out.push(C('Levelling', 'Misclose', 'warn', `${sgn(res.misclose * 1000, 1)} mm`, '', 'Enter run length (km) to test.'));
  else {
    const tol = levellingTol(km, S), mm = res.misclose * 1000;
    out.push(C('Levelling', 'Misclose', Math.abs(mm) <= tol + 1e-6 ? 'pass' : 'fail', `${sgn(mm, 1)} mm`, `±${tol.toFixed(1)} mm (${fmtG(S.lev_k)}√${fmtG(km)} km)`));
  }
  return out;
}

export function gnssChecks(session) {
  const pts = gnssResolve(session);
  if (!pts.length) return [];
  const out = [];
  for (const p of pts) {
    for (const e of p.errors) out.push(C('GNSS', `Point ${p.id || '?'}`, 'fail', '', '', e));
    for (const f of p.flags) out.push(C('GNSS', `Point ${p.id || '?'}`, 'warn', '', '', f));
  }
  const bad = pts.filter((p) => p.flagged).length;
  out.push(C('GNSS', 'Observation quality', bad ? 'warn' : 'pass', `${pts.length - bad} of ${pts.length} point(s) clean`));
  return out;
}

export function fieldChecks(session, tolData) {
  const run = runTraverse(session);
  const checks = [];
  if (run.ok) checks.push(...traverseChecks(run.result, session.settings, tolData));
  else if ((session.observations || []).length) for (const e of run.errors) checks.push(C('Traverse', 'Calculation', 'fail', '', '', e));
  const lr = levelResult(session);
  checks.push(...levellingChecks(lr, (session.levelling || {}).length_km, session.settings, tolData));
  checks.push(...gnssChecks(session));
  const count = (s) => checks.filter((c) => c.status === s).length;
  const overall = count('fail') ? 'FAIL' : count('warn') ? 'PASS with warnings' : 'PASS';
  return { run, level: lr, checks, overall, counts: { pass: count('pass'), fail: count('fail'), warn: count('warn'), info: count('info') } };
}
