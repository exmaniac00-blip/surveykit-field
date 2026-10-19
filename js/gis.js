// Google Identity Services token model (browser only). Loads https://accounts.google.com/gsi/client on demand,
// asks for drive.file, keeps the short-lived access token in memory (+ sessionStorage) – no refresh token.
export const SCOPE = 'https://www.googleapis.com/auth/drive.file';
let tokenClient = null, token = null, expires = 0;

function loadScript() {
  if (globalThis.google && google.accounts && google.accounts.oauth2) return Promise.resolve();
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client'; s.async = true;
    s.onload = () => res(); s.onerror = () => rej(new Error('Could not load Google sign-in (offline?)'));
    document.head.appendChild(s);
  });
}
export function hasToken() {
  if (!token) {
    try { const t = JSON.parse(sessionStorage.getItem('sk_tok') || 'null'); if (t && t.exp > Date.now()) { token = t.tok; expires = t.exp; } } catch { /* ignore */ }
  }
  return !!token && Date.now() < expires - 60000;
}
export async function connect(clientId, interactive = true) {
  if (!clientId) throw new Error('Enter your OAuth Web client ID in Settings first (docs/google_drive_setup.md).');
  await loadScript();
  return new Promise((res, rej) => {
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: clientId, scope: SCOPE,
      callback: (r) => {
        if (r.error) return rej(new Error(r.error_description || r.error));
        token = r.access_token; expires = Date.now() + (Number(r.expires_in) || 3600) * 1000;
        try { sessionStorage.setItem('sk_tok', JSON.stringify({ tok: token, exp: expires })); } catch { /* ignore */ }
        res(token);
      },
      error_callback: (e) => rej(new Error(e && e.message ? e.message : 'Google sign-in was closed')),
    });
    tokenClient.requestAccessToken({ prompt: interactive ? '' : 'none' });   // '' = consent only the first time
  });
}
export function signOut() {
  if (token && globalThis.google) google.accounts.oauth2.revoke(token, () => {});
  token = null; expires = 0;
  try { sessionStorage.removeItem('sk_tok'); } catch { /* ignore */ }
}
export function authFetch(url, init = {}) {
  if (!hasToken()) return Promise.reject(Object.assign(new Error('Google Drive sign-in expired – tap Connect.'), { auth: true }));
  return fetch(url, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` } });
}
