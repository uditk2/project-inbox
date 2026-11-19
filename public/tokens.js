const $ = id => document.getElementById(id);
async function call(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json' } });
  if (response.status === 401) { location.assign('/'); return {}; }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Request failed');
  return data;
}
function show(message) { $('error').textContent = message; $('error').hidden = !message; }
async function load() {
  const { tokens = [] } = await call('/api/tokens');
  $('list').replaceChildren(...tokens.map(t => {
    const row = document.createElement('div'); row.className = 'token-row';
    const text = document.createElement('span');
    text.textContent = `${t.name} · created ${t.created_at.slice(0, 10)} · ${t.last_used_at ? 'used ' + t.last_used_at.slice(0, 10) : 'never used'}`;
    const revoke = document.createElement('button'); revoke.textContent = 'Revoke'; revoke.className = 'secondary';
    revoke.onclick = async () => { try { await call(`/api/tokens/${encodeURIComponent(t.id)}`, { method: 'DELETE', body: '{}' }); await load(); } catch (e) { show(e.message); } };
    row.append(text, revoke); return row;
  }));
}
$('create').onsubmit = async event => {
  event.preventDefault(); show('');
  try {
    const made = await call('/api/tokens', { method: 'POST', body: JSON.stringify({ name: $('name').value }) });
    $('created').hidden = false;
    $('created').replaceChildren(Object.assign(document.createElement('p'), { textContent: 'Copy this token now. It will not be shown again.' }), Object.assign(document.createElement('div'), { className: 'token-new', textContent: made.token }));
    $('name').value = ''; await load();
  } catch (e) { show(e.message); }
};
load().catch(e => show(e.message));
