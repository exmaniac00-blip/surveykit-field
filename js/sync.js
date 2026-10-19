// Sync rules – identical to surveykit/sync/engine.py (see that docstring). Adapter = DriveAdapter or a test fake.
import { exportZip, importZip, sha256Hex } from './projzip.js';

export const ZIP = 'project.zip', META = 'sync.json';
const dec = new TextDecoder();
export const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  return JSON.stringify(v === undefined ? null : v);
}
export async function contentSha(session) {
  const { sync, ...rest } = session;   // eslint-disable-line no-unused-vars
  return sha256Hex(stable(rest));
}
export const defaultSync = () => ({ project: '', rev: 0, content_sha: '', synced_at: '', edited_at: '', device_id: '' });
export function touch(session, when) { session.sync = { ...defaultSync(), ...(session.sync || {}), edited_at: when || nowIso() }; }
export async function isDirty(session) { return (await contentSha(session)) !== ((session.sync || {}).content_sha || ''); }

export async function readMeta(ad, project) {
  const raw = await ad.read(project, META);
  if (!raw) return null;
  try { const m = JSON.parse(dec.decode(raw)); m.rev = parseInt(m.rev || 0, 10); return m; } catch { return null; }
}
export function conflictName(device, when) {
  const t = (when || nowIso()).replace(/[-:]/g, '').replace('T', '-').replace(/Z$/, '').slice(0, 15);
  const dev = String(device).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || 'device';
  return `project-conflict-${dev}-${t}.zip`;
}

async function push(ad, project, session, deviceId, rev, now) {
  const s = structuredClone(session);
  const sha = await contentSha(s);
  s.sync = { ...defaultSync(), ...(s.sync || {}), project, rev, content_sha: sha, synced_at: now, device_id: deviceId };
  s.sync.edited_at = s.sync.edited_at || now;
  const raw = exportZip(s);
  const meta = { rev, device_id: deviceId, modified: s.sync.edited_at, sha256: await sha256Hex(raw), content_sha: sha, uploaded_at: now };
  await ad.write(project, ZIP, raw);
  await ad.write(project, META, JSON.stringify(meta, null, 1));
  return [s, meta];
}
async function pull(ad, project, meta, deviceId, now) {
  const raw = await ad.read(project, ZIP);
  if (!raw || (meta.sha256 && (await sha256Hex(raw)) !== meta.sha256)) return null;
  const s = importZip(raw);
  s.sync = { ...defaultSync(), project, rev: meta.rev, content_sha: '', synced_at: now, edited_at: meta.modified || '', device_id: deviceId };
  s.sync.content_sha = await contentSha(s);
  return s;
}
const R = (action, session, message, meta = null, extra = {}) => ({ action, session, message, meta, extra });

// backups: optional async (name, bytes) => void – keeps the losing copy of a last-write-wins conflict on the phone
export async function sync(ad, session, project, deviceId, policy = 'lww', now = null, backups = null) {
  now = now || nowIso();
  const local = session.sync || {};
  const same = local.project === project;
  const base = same ? parseInt(local.rev || 0, 10) : 0;
  const dirty = (await isDirty(session)) || !same;
  const meta = await readMeta(ad, project);
  if (!meta) { const [s, m] = await push(ad, project, session, deviceId, Math.max(base, 0) + 1, now); return R('uploaded', s, `Uploaded ${project} (rev ${m.rev}).`, m); }
  const r = meta.rev;
  if (r === base && same) {
    if (!dirty) return R('up-to-date', session, `${project} is up to date (rev ${r}).`, meta);
    const [s, m] = await push(ad, project, session, deviceId, r + 1, now);
    return R('uploaded', s, `Uploaded ${project} (rev ${m.rev}).`, m);
  }
  if (r < base && same) { const [s, m] = await push(ad, project, session, deviceId, base + 1, now); return R('uploaded', s, `Remote was older (rev ${r}); uploaded rev ${m.rev}.`, m); }
  if (!dirty) {
    const s = await pull(ad, project, meta, deviceId, now);
    return s ? R('downloaded', s, `Downloaded ${project} rev ${r} from ${meta.device_id || '?'}.`, meta) : R('retry', session, 'Remote project is still syncing – try again shortly.', meta);
  }
  if (policy === 'keep_both') {
    const name = conflictName(deviceId, now);
    await ad.write(project, name, exportZip(session));
    const s = await pull(ad, project, meta, deviceId, now);
    if (!s) return R('retry', session, `Remote project is still syncing – your copy was saved as ${name}`, meta);
    return R('conflict-kept-both', s, `Conflict: both changed. Your version was saved as ${name}; the remote rev ${r} is now open.`, meta, { conflict_file: name });
  }
  const lm = local.edited_at || now, rm = meta.modified || '1970-01-01T00:00:00Z';
  const cmp = lm !== rm ? (lm > rm ? 1 : -1) : base !== r ? (base > r ? 1 : -1) : (deviceId > (meta.device_id || '') ? 1 : -1);
  if (cmp > 0) {
    const old = await ad.read(project, ZIP);
    if (old && backups) await backups(`${project}-${conflictName(meta.device_id || 'remote', now)}`, old);
    const [s, m] = await push(ad, project, session, deviceId, r + 1, now);
    return R('conflict-lww-local', s, `Conflict: your edit (${lm}) is newer than the remote (${rm}); uploaded rev ${m.rev}. Previous remote copy backed up.`, m);
  }
  const s = await pull(ad, project, meta, deviceId, now);
  if (!s) return R('retry', session, 'Remote project is still syncing – try again shortly.', meta);
  if (backups) await backups(`${project}-${conflictName(deviceId, now)}`, exportZip(session));
  return R('conflict-lww-remote', s, `Conflict: remote edit (${rm}) is newer than yours (${lm}); downloaded rev ${r}. Your copy was backed up.`, meta);
}

// ------------------------------------------------------------------------------------------- workflow queue
export function newRequest(workflow, requestedBy, now = new Date()) {
  const ts = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const rnd = [...crypto.getRandomValues(new Uint8Array(3))].map((x) => x.toString(16).padStart(2, '0')).join('');
  return { request_id: `${ts}-${rnd}`, workflow, requested_by: requestedBy, requested_at: nowIso() };
}
export const queuedStatus = (req) => ({ request_id: req.request_id, workflow_id: req.workflow.id, workflow_name: req.workflow.name, state: 'queued',
  requested_by: req.requested_by || '', requested_at: req.requested_at || '', updated_at: nowIso(), steps: [], outputs: [] });
export async function enqueue(ad, project, req) {
  await ad.write(project, `status/${req.request_id}.json`, JSON.stringify(queuedStatus(req), null, 1));
  await ad.write(project, `queue/${req.request_id}.json`, JSON.stringify(req, null, 1));
}
export async function statuses(ad, project) {
  const out = [];
  for (const f of await ad.listFiles(project, 'status')) {
    try { out.push(JSON.parse(dec.decode(await ad.read(project, `status/${f}`)))); } catch { /* skip */ }
  }
  return out.sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
}
