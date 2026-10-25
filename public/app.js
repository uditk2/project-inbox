'use strict';
const $ = (id) => document.getElementById(id);
const state = { accounts: [], folder: 'inbox', account: '', query: '', messages: [], selected: null, offset: 0, demo: false, ready: false, loading: false, requestId: null, replyToId: null, seen: new Set(), initialized: false, generation: 0 };
const el = (tag, className, text) => { const n = document.createElement(tag); if (className) n.className = className; if (text != null) n.textContent = text; return n; };
function notice(text) { $('notice').textContent = text || ''; $('notice').hidden = !text; }
async function api(path, options = {}) { let response; try { response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } }); } catch { throw new Error('The local app is not reachable. Start Project Inbox again, then refresh this page. Your saved accounts are still on this Mac.'); } const data = await response.json().catch(() => ({})); if (!response.ok) { const error = new Error(response.status === 429 ? 'Your email provider is busy. Saved messages are available; we’ll try syncing again shortly.' : data.error || (response.status === 401 || response.status === 403 ? 'This request was blocked. Open the app from its local address and try again.' : 'We could not complete that request. Please try again.')); error.status = response.status; throw error; } return data; }
const accountName = (id) => state.accounts.find(a => a.id === id)?.name || 'Project';
function senderName(sender) { return String(sender || 'Unknown sender').replace(/\s*<[^>]*>/, '').replace(/^"|"$/g, '') || String(sender); }
function recipients(value) { if (Array.isArray(value)) return value.join(', '); try { const parsed = JSON.parse(value || '[]'); return Array.isArray(parsed) ? parsed.join(', ') : String(value || ''); } catch { return String(value || ''); } }
function formatDate(value, full = false) { const d = new Date(value); if (Number.isNaN(d.getTime())) return ''; return full ? d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric' }); }
function renderAccounts() { $('accounts').replaceChildren(); const all = el('button', 'nav-item' + (!state.account ? ' active' : ''), 'All inboxes'); all.onclick = () => selectAccount(''); $('accounts').append(all); state.accounts.forEach((a, i) => { const b = el('button', 'nav-item' + (state.account === a.id ? ' active' : '')); const label = el('span', 'account-name'); const dot = el('span', 'project-dot'); dot.style.background = ['#819ff0', '#6fc4b0', '#c59ce3', '#e5ba76'][i % 4]; label.append(dot, document.createTextNode(a.name)); b.append(label); b.onclick = () => selectAccount(a.id); $('accounts').append(b); }); $('scope').textContent = state.account ? accountName(state.account) : 'All inboxes'; }
function selectAccount(id) { state.account = id; state.selected = null; renderAccounts(); resetReader(); loadMessages(); }
function resetReader() { $('reader').replaceChildren(); const box = el('div', 'reader-empty'); box.append(el('div', 'empty-icon', '✉'), el('h2', '', 'A little more focus.'), el('p', '', 'Choose a message to read it here.')); $('reader').append(box); document.querySelector('.mail-workspace').classList.remove('reader-open'); }
function renderMessages() { const list = $('messages'); list.replaceChildren(); $('message-count').textContent = state.messages.length ? String(state.messages.length) : ''; if (!state.messages.length) { const empty = el('div', 'list-empty'); empty.append(el('strong', '', state.accounts.length ? (state.folder === 'trash' ? 'Trash is empty.' : 'You’re all caught up.') : 'Your workspace is ready for mail.'), el('span', '', state.accounts.length ? (state.query ? 'No messages match your search.' : (state.folder === 'trash' ? 'Messages you move to Trash appear here until restored or permanently deleted.' : 'Messages will appear here when they arrive.')) : 'Connect your first project in Settings to start receiving mail.')); if (state.settingsAvailable || state.demo) empty.append(action('Connect a project', () => showSettings(), 'secondary')); list.append(empty); return; } state.messages.forEach(m => { const b = el('button', 'message' + (!m.is_read ? ' unread' : '') + (state.selected === m.id ? ' selected' : '')); b.setAttribute('role', 'listitem'); b.setAttribute('aria-label', `${senderName(m.sender)}: ${m.subject || '(No subject)'}`); const top = el('div', 'message-top'); top.append(el('span', 'sender', state.folder === 'sent' ? recipients(m.recipients) : senderName(m.sender)), el('time', 'message-time', formatDate(m.received_at))); const bottom = el('div', 'message-bottom'); bottom.append(el('span', 'project-tag', accountName(m.account_id))); if (!m.is_read) bottom.append(el('span', 'unread-dot')); b.append(top, el('span', 'subject', m.subject || '(No subject)'), el('span', 'preview', m.preview || 'Open to read message'), bottom); b.onclick = () => openMessage(m.id); list.append(b); }); }
async function loadMessages({ append = false, quiet = false } = {}) { if (!state.ready) return; const generation = ++state.generation; if (!quiet) $('sync-status').textContent = 'Updating inbox…'; const offset = append ? state.messages.length : 0; const params = new URLSearchParams({ folder: state.folder, offset: String(offset) }); if (state.account) params.set('account', state.account); if (state.query) params.set('q', state.query); try { const data = await api(`/api/messages?${params}`); if (generation !== state.generation) return; const rows = data.messages || []; if (state.initialized && quiet && document.visibilityState === 'visible' && 'Notification' in window && Notification.permission === 'granted') { const incoming = rows.filter(m => !state.seen.has(m.id) && m.direction !== 'outbound' && !m.is_read); if (incoming.length) new Notification('Project Inbox', { body: `${incoming.length} new ${incoming.length === 1 ? 'message' : 'messages'} in your workspace.` }); } rows.forEach(m => state.seen.add(m.id)); state.initialized = true; state.messages = append ? [...state.messages, ...rows] : rows; $('load-more').hidden = !data.hasMore; const unread = (data.unread || []).reduce((n, a) => n + Number(a.unread || 0), 0); $('unread-count').textContent = String(unread); renderMessages(); $('sync-status').textContent = 'Saved mail loaded'; return true; } catch (e) { if (generation === state.generation) { notice(e.message); $('sync-status').textContent = 'Could not sync · Use refresh to retry'; } return false; } }
async function openMessage(id) { state.selected = id; renderMessages(); $('reader').replaceChildren(el('div', 'list-empty', 'Opening message…')); document.querySelector('.mail-workspace').classList.add('reader-open'); try { const m = await api(`/api/messages/${encodeURIComponent(id)}`); if (state.selected !== id) return; renderReader(m); if (!m.is_read) { await api(`/api/messages/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ read: true }) }); const row = state.messages.find(r => r.id === id); if (row) row.is_read = 1; renderMessages(); loadMessages({ quiet: true }); } } catch (e) { notice(e.message); } }
function action(label, fn, className = 'text-button') { const b = el('button', className, label); b.onclick = fn; return b; }
function renderReader(m) { const reader = $('reader'); reader.replaceChildren(); const toolbar = el('div', 'reader-toolbar'); const left = el('div', 'toolbar-group'); left.append(action('← Back', () => document.querySelector('.mail-workspace').classList.remove('reader-open'), 'text-button back-button')); if (m.trashed || state.folder === 'trash') { left.append(action('↥ Restore', () => patchMessage(m.id, { trashed: false })), action('Delete permanently', () => deleteMessage(m.id), 'text-button danger-button')); } else { left.append(action(m.archived ? '↥ Unarchive' : '▣ Archive', () => patchMessage(m.id, { archived: !m.archived })), action('Mark unread', () => patchMessage(m.id, { read: false })), action('Move to Trash', () => patchMessage(m.id, { trashed: true }))); } toolbar.append(left, el('span', 'project-tag', accountName(m.account_id))); const content = el('div', 'reader-content'); content.append(el('h2', '', m.subject || '(No subject)')); const sender = el('div', 'sender-detail'); sender.append(el('span', 'avatar', senderName(m.sender).slice(0, 1).toUpperCase())); const info = el('div', 'sender-info'); info.append(el('strong', '', senderName(m.sender)), el('p', '', String(m.sender || '')), el('p', '', 'To: ' + recipients(m.recipients))); sender.append(info, el('time', 'reader-date', formatDate(m.received_at, true))); content.append(sender); if (m.body_text || !m.body_html) content.append(el('div', 'body-text', m.body_text || m.preview || '(This message has no text content.)')); else { const frame = el('iframe', 'email-body'); frame.title = 'Email content'; frame.setAttribute('sandbox', ''); frame.referrerPolicy = 'no-referrer'; frame.srcdoc = '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data:; base-uri \'none\'; form-action \'none\'"><style>body{font:14px/1.7 sans-serif;color:#42516c;overflow-wrap:anywhere}img{max-width:100%}</style></head><body>' + m.body_html + '</body></html>'; content.append(frame); } let files = []; try { files = typeof m.attachments === 'string' ? JSON.parse(m.attachments) : m.attachments || []; } catch {} if (files.length) { const attachments = el('div', 'attachments'); files.forEach(a => { const link = el('a', '', '↓ ' + (a.filename || a.name || 'Attachment')); link.href = `/api/attachments/${encodeURIComponent(m.id)}/${encodeURIComponent(a.id)}`; link.setAttribute('download', ''); attachments.append(link); }); content.append(attachments); } if (m.direction !== 'outbound' && !m.trashed && state.folder !== 'trash') content.append(action('↩ Reply', () => compose(m), 'reply-button')); reader.append(toolbar, content); }
async function patchMessage(id, patch) { try { await api(`/api/messages/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }); if ('archived' in patch || 'trashed' in patch) { state.selected = null; resetReader(); } await loadMessages({ quiet: true }); } catch (e) { notice(e.message); } }
async function deleteMessage(id) {
  if (!window.confirm('Permanently delete this local copy? This cannot be undone. It does not delete the copy held by Resend.')) return;
  try {
    await api(`/api/messages/${encodeURIComponent(id)}`, { method: 'DELETE', body: JSON.stringify({ confirm: true }) });
    state.selected = null; resetReader(); await loadMessages({ quiet: true });
    notice('Local copy permanently deleted. The copy held by Resend is unchanged.');
  } catch (error) { notice(error.message); }
}
function compose(reply) { if (!state.ready || !state.accounts.length) { notice('Connect a project in Settings before composing a message.'); return; } $('compose-form').reset(); $('send-text').replaceChildren(); editorSelection = null; $('link-controls').hidden = true; $('send-account').replaceChildren(); state.accounts.forEach(a => { const option = el('option', '', `${a.name} · ${a.mailbox}`); option.value = a.id; $('send-account').append(option); }); $('send-account').value = reply?.account_id || state.account || state.accounts[0].id; state.replyToId = reply?.id || null; state.requestId = null; $('send-to').value = reply ? String(reply.sender || '').match(/<([^>]+)>/)?.[1] || reply.sender : ''; $('send-subject').value = reply ? (/^re:/i.test(reply.subject || '') ? reply.subject : 'Re: ' + (reply.subject || '')) : ''; $('compose-title').textContent = reply ? 'Reply' : 'New message'; $('send-error').hidden = true; $('send').disabled = state.demo; $('compose-help').textContent = state.demo ? 'Sending is disabled in this demo.' : 'Replies stay with the right project.'; $('compose-dialog').showModal(); (reply ? $('send-text') : $('send-to')).focus(); }
$('compose').onclick = () => compose(); $('close-compose').onclick = () => $('compose-dialog').close(); $('compose-form').addEventListener('input', () => { state.requestId = null; }); $('compose-form').addEventListener('change', () => { state.requestId = null; });
$('compose-form').onsubmit = async event => { event.preventDefault(); if (state.demo) return; const messageText = $('send-text').innerText; const messageHtml = $('send-text').innerHTML; if (!messageText.trim()) { $('send-error').textContent = 'Write a message before sending.'; $('send-error').hidden = false; $('send-text').focus(); return; } if (messageHtml.length > 100000) { $('send-error').textContent = 'This message is too long. Please shorten it before sending.'; $('send-error').hidden = false; return; } if (!state.requestId) state.requestId = crypto.randomUUID(); const payload = { accountId: $('send-account').value, to: $('send-to').value.trim(), subject: $('send-subject').value.trim(), text: messageText, html: messageHtml, requestId: state.requestId }; if (state.replyToId) payload.replyToId = state.replyToId; $('send').disabled = true; $('send').textContent = 'Sending…'; $('send-error').hidden = true; try { await api('/api/send', { method: 'POST', body: JSON.stringify(payload) }); $('compose-dialog').close(); notice('Message sent.'); state.requestId = null; loadMessages({ quiet: true }); } catch (e) { $('send-error').textContent = e.message; $('send-error').hidden = false; } finally { $('send').disabled = false; $('send').textContent = 'Send message ↗'; } };
document.querySelectorAll('[data-folder]').forEach(b => { b.onclick = () => { state.folder = b.dataset.folder; state.selected = null; document.querySelectorAll('[data-folder]').forEach(n => n.classList.toggle('active', n === b)); $('folder-title').textContent = b.dataset.folder[0].toUpperCase() + b.dataset.folder.slice(1); resetReader(); loadMessages(); }; });
let searchTimer; $('search').oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { state.query = $('search').value.trim(); loadMessages(); }, 250); }; $('refresh').onclick = () => { notice(''); refreshWorkspace(); }; $('load-more').onclick = () => loadMessages({ append: true });
$('notifications').onclick = async () => { if (!('Notification' in window)) { notice('Desktop notifications are not supported by this browser.'); return; } const permission = await Notification.requestPermission(); $('notifications').textContent = permission === 'granted' ? '✓ Notifications enabled' : '♧ Notifications unavailable'; if (permission !== 'granted') notice('You can enable notifications for this site in your browser settings.'); };
document.addEventListener('keydown', e => { if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); $('search').focus(); } }); document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refreshWorkspace({ quiet: true }); }); window.addEventListener('focus', () => refreshWorkspace({ quiet: true })); setInterval(() => { if (document.visibilityState === 'visible') refreshWorkspace({ quiet: true }); }, 60000);
async function boot() { try { const data = await api('/api/session'); state.accounts = data.accounts || []; state.settingsAvailable = !!data.settingsAvailable; state.demo = !!data.demo; renderSettingsButton(); state.ready = true; $('demo').hidden = !state.demo; $('user').textContent = data.email || 'Your workspace'; $('compose').disabled = false; renderAccounts(); document.querySelector('.mail-workspace').classList.toggle('onboarding-open', !state.accounts.length); if (!state.accounts.length) renderOnboarding(); else if ($('reader').querySelector('.onboarding')) resetReader(); await refreshWorkspace(); } catch (e) { notice(e.message); $('sync-status').textContent = 'Workspace unavailable'; $('compose').disabled = true; const empty = el('div', 'list-empty'); empty.append(el('strong', '', 'Your local inbox is unavailable.'), el('span', '', 'Check that Project Inbox is still running on this Mac, then refresh this page.')); $('messages').replaceChildren(empty); } }

let syncPromise = null;
let lastSync = 0;
let syncAccountOffset = 0;
async function refreshWorkspace({ quiet = false } = {}) {
  if (!state.ready) return;
  if (syncPromise) return syncPromise;
  if (quiet && Date.now() - lastSync < 15000) return;
  syncPromise = (async () => {
    $('sync-status').textContent = 'Checking project mail…';
    let syncError = null;
    let pages = 0;
    const accounts = state.accounts;
    for (let index = 0; index < accounts.length && pages < 3; index++) {
      const account = accounts[(syncAccountOffset + index) % accounts.length];
      let hasMore = true;
      while (hasMore && pages < 3) {
        await new Promise(resolve => setTimeout(resolve, 650));
        pages++;
        try {
          const result = await api('/api/sync', { method: 'POST', body: JSON.stringify({ accountId: account.id }) });
          hasMore = !!result.hasMore;
        } catch (error) { syncError = error; hasMore = false; break; }
      }
      if (syncError?.status === 429 || syncError?.status === 401 || syncError?.status === 403) break;
    }
    if (accounts.length) syncAccountOffset = (syncAccountOffset + 1) % accounts.length;
    lastSync = Date.now();
    const loaded = await loadMessages({ quiet });
    if (!syncError && loaded) { $('sync-status').textContent = 'Up to date · ' + new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); if (/^(Project connected\.|The local app is not reachable\.|Your email provider is busy\.)/.test($('notice').textContent)) notice(''); }
    if (syncError) { notice(syncError.message); $('sync-status').textContent = loaded ? 'Saved mail available · Sync will retry' : 'Local app unavailable · Refresh to retry'; }
  })();
  try { await syncPromise; } finally { syncPromise = null; }
}
function renderOnboarding() {
  $('reader').replaceChildren();
  const welcome = el('div', 'onboarding');
  welcome.append(el('span', 'onboarding-mark', '✉'), el('p', 'eyebrow', 'LET’S MAKE YOURSELF AT HOME'), el('h2', '', 'Your projects. One inbox.'), el('p', 'onboarding-intro', 'Connect your first Resend account to start reading and replying to project mail here.'));
  const steps = el('div', 'onboarding-steps');
  [['1', 'Choose your project', 'Give the inbox a name and the email address you send from.'], ['2', 'Connect Resend', 'Add a full-access API key. It stays encrypted on this Mac.'], ['3', 'Settle into your inbox', 'Your connected accounts stay ready on this Mac for your next visit.']].forEach(([number, heading, copy]) => { const row = el('div', 'onboarding-step'); const text = el('div'); text.append(el('strong', '', heading), el('p', '', copy)); row.append(el('span', 'step-number', number), text); steps.append(row); });
  welcome.append(steps, action('Connect your first project →', () => showSettings(), 'primary'), el('p', 'onboarding-footnote', 'Runs on your Mac. No login, cloud account, or personal inbox access needed.'));
  $('reader').append(welcome); document.querySelector('.mail-workspace').classList.add('onboarding-open');
}


let settingsDialog;
function renderSettingsButton() {
  if (!(state.settingsAvailable || state.demo) || $('settings-button')) return;
  const button = action('Settings', () => showSettings(), 'text-button');
  button.id = 'settings-button'; document.querySelector('.top-actions').append(button);
}
function showSettings() {
  if (settingsDialog) settingsDialog.remove();
  settingsDialog = el('dialog', 'settings-dialog');
  const form = el('form'); const header = el('header', 'modal-header');
  const title = el('div'); title.append(el('p', 'eyebrow', 'YOUR WORKSPACE'), el('h2', '', 'Connect a project'));
  const close = action('×', () => { form.reset(); settingsDialog.close(); }, 'icon-button'); close.setAttribute('aria-label', 'Close settings'); header.append(title, close);
  const fields = el('div', 'compose-fields');
  fields.append(el('p', 'login-copy', 'Bring another project into your inbox. Use a full-access Resend API key to read and send mail. Credentials are stored encrypted locally on this Mac.'));
  const pickerLabel = el('label', '', 'Project'); const picker = el('select'); const fresh = el('option', '', 'Add a new project'); fresh.value = ''; picker.append(fresh);
  state.accounts.forEach(a => { const option = el('option', '', a.name); option.value = a.id; picker.append(option); }); pickerLabel.append(picker); fields.append(pickerLabel);
  function field(labelText, type, placeholder, required = true) { const label = el('label', '', labelText); const input = el('input'); input.type = type; input.placeholder = placeholder; input.required = required; input.autocomplete = 'off'; label.append(input); fields.append(label); return input; }
  const id = field('Project ID', 'text', 'slayfit'); id.pattern = '[a-z0-9]+(?:-[a-z0-9]+)*'; id.maxLength = 48;
  const name = field('Name', 'text', 'SlayFit');
  const mailbox = field('Address', 'email', 'you@example.com');
  const key = field('API key', 'password', 're_…');
  fields.append(el('p', 'login-copy', 'Project IDs keep accounts separate. Incoming mail must also be enabled for this address in Resend. Leave the API key blank when editing to keep the saved key.'));
  const error = el('p', 'send-error'); error.setAttribute('role', 'alert');
  const footer = el('footer', 'modal-footer'); const help = el('span', '', state.demo ? 'Demo cannot save credentials.' : 'Your API keys stay encrypted on this Mac.'); const save = el('button', 'primary', 'Save project'); save.type = 'submit'; save.disabled = state.demo; footer.append(help, save);
  picker.onchange = () => { const account = state.accounts.find(a => a.id === picker.value); id.value = account?.id || ''; id.readOnly = !!account; name.value = account?.name || ''; mailbox.value = account?.mailbox || ''; key.value = ''; key.required = !account; error.textContent = ''; };
  settingsDialog.addEventListener('close', () => { key.value = ''; });
  form.onsubmit = async event => {
    event.preventDefault(); if (state.demo) return;
    const payload = { id: id.value.trim(), name: name.value.trim(), mailbox: mailbox.value.trim(), apiKey: key.value.trim() };
    key.value = ''; save.disabled = true; error.textContent = '';
    try { await api('/api/accounts', { method: 'POST', body: JSON.stringify(payload) }); settingsDialog.close(); notice('Project connected. Checking for mail…'); await boot(); }
    catch (e) { error.textContent = e.message; }
    finally { save.disabled = state.demo; }
  };
  form.append(header, fields, error, footer); settingsDialog.append(form); document.body.append(settingsDialog); settingsDialog.showModal(); picker.focus();
}

let editorSelection = null;
const editor = $('send-text');
document.addEventListener('selectionchange', () => {
  const selection = window.getSelection();
  if (selection?.rangeCount && editor.contains(selection.anchorNode) && editor.contains(selection.focusNode)) editorSelection = selection.getRangeAt(0).cloneRange();
  if (document.activeElement === editor) document.querySelectorAll('[data-format][aria-pressed]').forEach(button => button.setAttribute('aria-pressed', String(document.queryCommandState(button.dataset.format))));
});
function restoreEditorSelection() {
  editor.focus();
  const selection = window.getSelection();
  if (editorSelection && editor.contains(editorSelection.commonAncestorContainer)) { selection.removeAllRanges(); selection.addRange(editorSelection); }
  else { const range = document.createRange(); range.selectNodeContents(editor); range.collapse(false); selection.removeAllRanges(); selection.addRange(range); }
}
function formatMessage(command, value = null) {
  restoreEditorSelection();
  const styles = { fontName: ['fontFamily', value], fontSize: ['fontSize', { 2: '12px', 3: '14px', 5: '20px' }[value]], bold: ['fontWeight', document.queryCommandState('bold') ? 'normal' : 'bold'], italic: ['fontStyle', document.queryCommandState('italic') ? 'normal' : 'italic'], underline: ['textDecoration', document.queryCommandState('underline') ? 'none' : 'underline'] };
  if (styles[command] && !window.getSelection().isCollapsed) {
    const range = window.getSelection().getRangeAt(0);
    const span = document.createElement('span');
    const [property, setting] = styles[command];
    span.style[property] = setting;
    span.append(range.extractContents());
    span.querySelectorAll('[style]').forEach(child => { child.style[property] = ''; });
    range.insertNode(span); range.selectNodeContents(span);
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    editorSelection = range.cloneRange();
  } else { document.execCommand('styleWithCSS', false, true); document.execCommand(command, false, value); const selection = window.getSelection(); if (selection.rangeCount) editorSelection = selection.getRangeAt(0).cloneRange(); }
  state.requestId = null;
  editor.dispatchEvent(new Event('input', { bubbles: true }));
}
document.querySelectorAll('[data-format]').forEach(button => {
  button.addEventListener('mousedown', event => event.preventDefault());
  button.onclick = () => formatMessage(button.dataset.format);
});
$('format-font').onchange = () => formatMessage('fontName', $('format-font').value);
$('format-size').onchange = () => formatMessage('fontSize', $('format-size').value);
$('format-link').addEventListener('mousedown', event => event.preventDefault());
$('format-link').onclick = () => { $('link-controls').hidden = false; $('format-url').value = ''; $('format-url').focus(); };
$('cancel-link').onclick = () => { $('link-controls').hidden = true; restoreEditorSelection(); };
$('apply-link').onclick = () => {
  const raw = $('format-url').value.trim();
  let url;
  try { url = new URL(raw); if (!['https:', 'http:', 'mailto:'].includes(url.protocol)) throw new Error(); }
  catch { $('send-error').textContent = 'Use a complete https, http, or mailto link.'; $('send-error').hidden = false; $('format-url').focus(); return; }
  $('send-error').hidden = true; $('link-controls').hidden = true; restoreEditorSelection();
  if (window.getSelection().isCollapsed) {
    const anchor = document.createElement('a'); anchor.href = url.href; anchor.textContent = url.href;
    const range = window.getSelection().getRangeAt(0); range.insertNode(anchor); range.setStartAfter(anchor); range.collapse(true); window.getSelection().removeAllRanges(); window.getSelection().addRange(range); state.requestId = null; editor.dispatchEvent(new Event('input', { bubbles: true }));
  } else formatMessage('createLink', url.href);
};
editor.addEventListener('paste', event => { event.preventDefault(); const text = event.clipboardData?.getData('text/plain') || ''; formatMessage('insertText', text); });
editor.addEventListener('dragover', event => event.preventDefault());
editor.addEventListener('drop', event => { event.preventDefault(); const text = event.dataTransfer?.getData('text/plain') || ''; if (text) formatMessage('insertText', text); });
$('format-url').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); $('apply-link').click(); } });

let feedbackDialog;
async function showFeedback() {
  if (feedbackDialog) feedbackDialog.remove();
  feedbackDialog = el('dialog', 'feedback-dialog');
  const form = el('form'); const header = el('header', 'modal-header'); const title = el('div');
  title.append(el('p', 'eyebrow', 'HELP SHAPE PROJECT INBOX'), el('h2', '', 'What should we improve?'));
  const close = action('×', () => feedbackDialog.close(), 'icon-button'); close.setAttribute('aria-label', 'Close feedback'); header.append(title, close);
  const content = el('div', 'feedback-content');
  content.append(el('p', 'login-copy', 'Save an idea or issue for later. Feedback stays on this Mac and is not sent anywhere. No email content is collected automatically.'));
  const label = el('label', 'sr-only', 'Feedback'); const textarea = el('textarea'); textarea.id = 'feedback-message'; label.htmlFor = textarea.id; textarea.required = true; textarea.maxLength = 10000; textarea.placeholder = 'An issue you noticed, a feature you need, or a small detail we could improve…';
  const error = el('p', 'send-error'); error.setAttribute('role', 'alert');
  const history = el('details', 'feedback-history'); const summary = el('summary', '', 'Saved feedback'); const entries = el('div', 'feedback-entries'); history.append(summary, entries);
  const exportLink = el('a', 'feedback-export', 'Export feedback as JSON'); exportLink.href = '/api/feedback/export'; exportLink.setAttribute('download', 'project-inbox-feedback.json');
  content.append(label, textarea, error, history, exportLink, el('p', 'feedback-public-note', 'GitHub issues are public. Review the text before submitting. No GitHub token is needed in this app.'));
  const footer = el('footer', 'modal-footer'); const status = el('span', '', 'Saved locally for your next improvement session.'); const save = el('button', 'primary', 'Save feedback'); save.type = 'submit'; footer.append(status, save); form.append(header, content, footer); feedbackDialog.append(form); document.body.append(feedbackDialog); feedbackDialog.showModal(); textarea.focus();
  async function loadHistory() {
    try { const data = await api('/api/feedback'); entries.replaceChildren(); const rows = (data.feedback || []).slice(0, 10); if (!rows.length) entries.append(el('p', 'login-copy', 'No feedback saved yet.')); rows.forEach(row => { const item = el('div', 'feedback-entry'); item.append(el('time', '', formatDate(row.created_at, true)), el('p', '', row.message)); const issue = el('a', 'feedback-issue', 'Review as GitHub issue ↗'); const title = ('Feedback: ' + String(row.message).split(/\r?\n/)[0]).slice(0, 90); const body = String(row.message) + '\n\n---\nApp version: 0.2.0\nSubmitted from locally saved feedback. No email content or configuration is attached automatically.'; const url = new URL('https://github.com/uditk2/project-inbox/issues/new'); url.searchParams.set('title', title); url.searchParams.set('body', body); issue.href = url.href; issue.target = '_blank'; issue.rel = 'noopener noreferrer'; item.append(issue); entries.append(item); }); }
    catch (e) { entries.replaceChildren(el('p', 'send-error', e.message)); }
  }
  form.onsubmit = async event => {
    event.preventDefault(); if (!textarea.value.trim()) { error.textContent = 'Write a little feedback before saving.'; textarea.focus(); return; }
    save.disabled = true; save.textContent = 'Saving…'; error.textContent = '';
    try { await api('/api/feedback', { method: 'POST', body: JSON.stringify({ message: textarea.value.trim() }) }); textarea.value = ''; status.textContent = 'Feedback saved on this Mac.'; history.open = true; await loadHistory(); }
    catch (e) { error.textContent = e.message; }
    finally { save.disabled = false; save.textContent = 'Save feedback'; }
  };
  await loadHistory();
}
$('feedback').onclick = () => showFeedback();
boot();
