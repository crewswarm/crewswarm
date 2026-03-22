// Simple fetch wrapper - no cache for dev tools
export async function getJSON(p, { ttl = 0, bust = false } = {}) {
  const r = await fetch(p);
  if (!r.ok) throw new Error(await r.text());
  return await r.json();
}

/** No-op - cache removed for dev tool responsiveness */
export function bustCache(p) {
  // No cache to bust
}

export async function postJSON(p, body, signal) {
  const r = await fetch(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
  const txt = await r.text();
  if (!r.ok) throw new Error(txt.slice(0, 120));
  try { return JSON.parse(txt); } catch { throw new Error('Bad response: ' + txt.slice(0, 80)); }
}
