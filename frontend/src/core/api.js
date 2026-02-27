export async function getJSON(p) {
  const r = await fetch(p);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function postJSON(p, body) {
  const r = await fetch(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const txt = await r.text();
  if (!r.ok) throw new Error(txt.slice(0, 120));
  try { return JSON.parse(txt); } catch { throw new Error('Bad response: ' + txt.slice(0, 80)); }
}
