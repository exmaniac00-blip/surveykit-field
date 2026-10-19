// Google Drive v3 REST adapter (scope drive.file) – same interface as surveykit/sync/gdrive.py:
// listProjects(), read(project, rel), write(project, rel, bytes), listFiles(project, subdir), changes(token).
// fetchFn(url, init) must add the bearer token (see gis.js) – a fake in tests.
const API = 'https://www.googleapis.com/drive/v3', UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER = 'application/vnd.google-apps.folder';
const q = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const enc = new TextEncoder();

export class DriveError extends Error {
  constructor(msg, status) { super(msg); this.status = status; }
}

export class DriveAdapter {
  constructor(fetchFn, rootId = null, rootName = 'SurveyKit Projects') {
    this.fetch = fetchFn; this.ids = new Map(); this.rootId = rootId; this.rootName = rootName; this.name = 'Google Drive';
  }
  async init() { if (!this.rootId) this.rootId = await this.ensureFolder(this.rootName, 'root'); return this; }
  async call(method, url, { params, json, body, headers } = {}) {
    const u = new URL(url);
    for (const [k, v] of Object.entries(params || {})) u.searchParams.set(k, v);
    const init = { method, headers: { ...(headers || {}) } };
    if (json !== undefined) { init.body = JSON.stringify(json); init.headers['Content-Type'] = 'application/json'; }
    else if (body !== undefined) init.body = body;
    const r = await this.fetch(u.toString(), init);
    if (r.status >= 400) {
      const t = await r.text().catch(() => '');
      throw new DriveError(`Drive ${method} ${u.pathname.split('/').pop()}: HTTP ${r.status} ${t.slice(0, 200)}`, r.status);
    }
    return r;
  }
  key(parent, name) { return `${parent}\u0000${name}`; }
  async find(name, parent, folder = null) {
    const k = this.key(parent, name);
    if (this.ids.has(k)) return this.ids.get(k);
    let qq = `name = '${q(name)}' and '${q(parent)}' in parents and trashed = false`;
    if (folder === true) qq += ` and mimeType = '${FOLDER}'`;
    else if (folder === false) qq += ` and mimeType != '${FOLDER}'`;
    const j = await (await this.call('GET', `${API}/files`, { params: { q: qq, fields: 'files(id,name,modifiedTime)', spaces: 'drive', pageSize: '10' } })).json();
    const f = (j.files || [])[0];
    if (f) { this.ids.set(k, f.id); return f.id; }
    return null;
  }
  async children(parent, folder) {
    const out = [];
    let token = null;
    do {
      const params = { q: `'${q(parent)}' in parents and trashed = false and mimeType ${folder ? '=' : '!='} '${FOLDER}'`, fields: 'nextPageToken,files(id,name)', pageSize: '200' };
      if (token) params.pageToken = token;
      const j = await (await this.call('GET', `${API}/files`, { params })).json();
      for (const f of j.files || []) this.ids.set(this.key(parent, f.name), f.id);
      out.push(...(j.files || []));
      token = j.nextPageToken;
    } while (token);
    return out;
  }
  async ensureFolder(name, parent) {
    const id = await this.find(name, parent, true);
    if (id) return id;
    const j = await (await this.call('POST', `${API}/files`, { params: { fields: 'id' }, json: { name, mimeType: FOLDER, parents: [parent] } })).json();
    this.ids.set(this.key(parent, name), j.id);
    return j.id;
  }
  async dir(project, parts, create) {
    let cur = this.rootId;
    for (const n of [project, ...parts]) {
      const nxt = create ? await this.ensureFolder(n, cur) : await this.find(n, cur, true);
      if (!nxt) return null;
      cur = nxt;
    }
    return cur;
  }
  async listProjects() { return (await this.children(this.rootId, true)).map((f) => f.name).sort(); }
  async read(project, rel) {
    const parts = rel.split('/'), fname = parts.pop();
    const d = await this.dir(project, parts, false);
    const id = d && await this.find(fname, d, false);
    if (!id) return null;
    return new Uint8Array(await (await this.call('GET', `${API}/files/${id}`, { params: { alt: 'media' } })).arrayBuffer());
  }
  async write(project, rel, data) {
    const bytes = typeof data === 'string' ? enc.encode(data) : data;
    const parts = rel.split('/'), fname = parts.pop();
    const d = await this.dir(project, parts, true);
    const id = await this.find(fname, d, false);
    if (id) {
      await this.call('PATCH', `${UPLOAD}/files/${id}`, { params: { uploadType: 'media' }, body: bytes, headers: { 'Content-Type': 'application/octet-stream' } });
      return;
    }
    const b = 'surveykit-boundary';
    const head = enc.encode(`--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name: fname, parents: [d] })}\r\n--${b}\r\nContent-Type: application/octet-stream\r\n\r\n`);
    const tail = enc.encode(`\r\n--${b}--`);
    const body = new Uint8Array(head.length + bytes.length + tail.length);
    body.set(head); body.set(bytes, head.length); body.set(tail, head.length + bytes.length);
    const j = await (await this.call('POST', `${UPLOAD}/files`, { params: { uploadType: 'multipart', fields: 'id' }, body, headers: { 'Content-Type': `multipart/related; boundary=${b}` } })).json();
    this.ids.set(this.key(d, fname), j.id);
  }
  async listFiles(project, subdir) {
    const d = await this.dir(project, subdir.split('/').filter(Boolean), false);
    return d ? (await this.children(d, false)).map((f) => f.name).sort() : [];
  }
  async changes(token) {
    if (!token) return [true, (await (await this.call('GET', `${API}/changes/startPageToken`)).json()).startPageToken];
    let changed = false, page = token;
    while (page) {
      const j = await (await this.call('GET', `${API}/changes`, { params: { pageToken: page, fields: 'nextPageToken,newStartPageToken,changes(fileId)' } })).json();
      changed = changed || (j.changes || []).length > 0;
      if (j.newStartPageToken) return [changed, j.newStartPageToken];
      page = j.nextPageToken;
    }
    return [changed, token];
  }
}
