/**
 * Thin wrapper over the Tauri global API (withGlobalTauri) so the rest of the
 * front-end never touches window.__TAURI__ directly.
 */
const T = globalThis.__TAURI__;
export const isTauri = !!T;

export function invoke(cmd, args) {
  if (!T) return Promise.reject(new Error('Not running inside Tauri'));
  return T.core.invoke(cmd, args || {});
}

export function listen(name, cb) {
  if (!T) return Promise.resolve(() => {});
  return T.event.listen(name, (e) => cb(e.payload));
}

/**
 * fetch-like function backed by the Rust http_request command. Returns
 * { status, text() }. Cookies for erp.usth.edu.vn are attached by Rust.
 */
export async function httpFetch(url, init = {}) {
  const headers = Object.entries(init.headers || {}).map(([k, v]) => [String(k), String(v)]);
  const r = await invoke('http_request', {
    req: { url, method: init.method || 'GET', headers, body: init.body == null ? null : String(init.body), timeoutMs: init.timeoutMs || 30000 },
  });
  return { status: r.status, ok: r.status >= 200 && r.status < 300, text: async () => r.body };
}
