/* ==========================================================================
 * SayScript dashboard (options page).
 *
 *   - Talks DIRECTLY to the PHP server over its own WebSocket so the editor is
 *     independent of the service-worker lifecycle.
 *   - Ctrl+S sends `update_script` → server writes the file → background gets
 *     `script_changed` and re-injects.
 *   - When the server pushes `script_changed`/`script_deleted`, the list and
 *     (if the file is open and unedited) the editor reload live.
 *   - Enable/disable toggles are forwarded to the background worker.
 * ======================================================================== */

const WS_URL = 'ws://localhost:8165';

/* ---------------- DOM refs ---------------- */
const $ = (id) => document.getElementById(id);
const els = {
  conn: $('conn'), connLabel: $('conn-label'),
  filter: $('filter'), list: $('script-list'), count: $('count'),
  defaultAuthor: $('default-author'),
  newBtn: $('new-btn'), resyncBtn: $('resync-btn'),
  headIcon: $('head-icon'), headName: $('head-name'), headFile: $('head-file'),
  enabledBtn: $('enabled-btn'),
  dirty: $('dirty'), statusMsg: $('status-msg'), historyLimit: $('history-limit'),
  saveBtn: $('save-btn'), deleteBtn: $('delete-btn'), closeBtn: $('close-btn'),
  historyBtn: $('history-btn'),
  metaBar: $('meta-bar'),
  // settings drawer
  settingsBtn: $('settings-btn'), settingsDrawer: $('settings-drawer'),
  settingsBackdrop: $('settings-backdrop'), settingsClose: $('settings-close'),
  clearAllBtn: $('clear-all-history-btn'), clearAllConfirm: $('clear-all-confirm'),
  clearAllInput: $('clear-all-input'), clearAllCancel: $('clear-all-cancel'), clearAllDo: $('clear-all-do'),
  // history dialog
  historyDialog: $('history-dialog'), historyFile: $('history-file'),
  historyList: $('history-list'), historyPreview: $('history-preview-code'),
  historyEmpty: $('history-empty'), historyMeta: $('history-meta'),
  historyRestore: $('history-restore'), historyClear: $('history-clear'),
  historyClose: $('history-close'), historyCloseX: $('history-close-x'),
  // confirm modal
  confirmDialog: $('confirm-dialog'), confirmTitle: $('confirm-title'),
  confirmBody: $('confirm-body'), confirmOk: $('confirm-ok'), confirmCancel: $('confirm-cancel'),
  gutter: $('gutter'), scroll: $('code-scroll'),
  highlight: $('highlight-code'), code: $('code'),
  pos: $('pos'), serverInfo: $('server-info'),
  importBtn: $('import-btn'), exportBtn: $('export-btn'), importFile: $('import-file'),
  importDialog: $('import-dialog'), importTitle: $('import-title'),
  importStatus: $('import-status'), importClose: $('import-close'),
  importProgress: $('import-progress'), importBar: $('import-bar'), importErrors: $('import-errors'),
};

/* ---------------- state ---------------- */
const scripts = new Map();      // filename -> record
let current = null;             // filename being edited (null while editing a new draft)
let isNewDraft = false;         // true when the editor holds an unsaved new script
let dirty = false;
let enabledMap = {};            // filename -> bool, mirrored from background
let socket = null;
let reconnectDelay = 1000;
let saveStateTimer = null;
let saveBtnTimer = null;
let historyCap = 20;            // user setting, mirrored to the server
let draftEnabled = true;        // enabled state chosen for an unsaved new script

const SAVE_BTN_HTML = '<span>Save</span><span class="kbd-hint"><kbd>Ctrl</kbd>+<kbd>S</kbd></span>';
// Captured at load so an "armed" button can restore its original icon+label.
const DELETE_BTN_HTML = els.deleteBtn.innerHTML;
const HISTORY_CLEAR_HTML = els.historyClear.innerHTML;

/* ===========================================================================
 * Confirm UI (replaces window.confirm / alert — MV3-friendly, no native popups)
 * ========================================================================= */

/** Promise-based confirm modal. Resolves true on confirm, false otherwise. */
let confirmResolve = null;
function confirmDialog({ title = 'Are you sure?', body = '', confirmLabel = 'Confirm', danger = false } = {}) {
  els.confirmTitle.textContent = title;
  els.confirmBody.textContent = body;
  els.confirmOk.textContent = confirmLabel;
  els.confirmOk.classList.toggle('btn--danger', danger);
  els.confirmOk.classList.toggle('btn--primary', !danger);
  return new Promise((resolve) => {
    confirmResolve = resolve;
    els.confirmDialog.showModal();
  });
}
function settleConfirm(val) {
  const r = confirmResolve;
  confirmResolve = null;
  if (els.confirmDialog.open) els.confirmDialog.close();
  if (r) r(val);
}
els.confirmOk.addEventListener('click', () => settleConfirm(true));
els.confirmCancel.addEventListener('click', () => settleConfirm(false));
// Esc / backdrop close → treat as cancel.
els.confirmDialog.addEventListener('close', () => settleConfirm(false));

/** Shared "you have unsaved edits" guard. Resolves true to proceed. */
function confirmDiscard(what) {
  return confirmDialog({
    title: 'Discard unsaved changes?',
    body: 'You have unsaved edits to ' + what + '. Discard them?',
    confirmLabel: 'Discard', danger: true,
  });
}

/** Two-step inline confirm on a button itself: first click arms it ("Confirm?"
 *  for 4s), a second click within that window runs `onConfirm`. */
function armButton(btn, restoreHTML, onConfirm, label = 'Confirm?') {
  if (btn.dataset.armed === '1') {
    disarmButton(btn, restoreHTML);
    onConfirm();
    return;
  }
  btn.dataset.armed = '1';
  btn.classList.add('is-arming');
  btn.innerHTML = '<span>' + label + '</span>';
  clearTimeout(btn._armTimer);
  btn._armTimer = setTimeout(() => disarmButton(btn, restoreHTML), 4000);
}
function disarmButton(btn, restoreHTML) {
  if (!btn) return;
  clearTimeout(btn._armTimer);
  if (btn.dataset.armed === '1') {
    btn.classList.remove('is-arming');
    btn.innerHTML = restoreHTML;
  }
  btn.dataset.armed = '0';
}

/* history viewer state */
let historyFor = null;          // filename the dialog is currently showing
let historyEntries = [];        // [{ id, ts, size }]
let historySelected = null;     // selected entry id
const historyCode = new Map();  // id -> code (lazy-fetched, dialog-scoped cache)

/* a script the popup asked us to open straight into the editor */
let pendingOpen = null;

/* Template used for a brand-new script (no modal, no name prompt). */
function buildNewTemplate(author) {
  const authorLine = author ? `// @author       ${author}\n` : '';
  return (
    '// ==UserScript==\n' +
    '// @name         Userscript Title\n' +
    '// @namespace    SayScript\n' +
    '// @version      1.0.0\n' +
    '// @description  -\n' +
    authorLine +
    '// @match        https://*/*\n' +
    '// @icon         https://url/to/icon.png\n' +
    '// @grant        none\n' +
    '// ==/UserScript==\n\n' +
    "(function() {\n    'use strict';\n\n    // Your code here...\n})();\n"
  );
}

/* ===========================================================================
 * WebSocket
 * ========================================================================= */

function connect() {
  setConn(false);
  socket = new WebSocket(WS_URL);

  socket.addEventListener('open', () => {
    setConn(true);
    reconnectDelay = 1000;
    socket.send(JSON.stringify({ action: 'fetch_all_scripts' }));
    sendHistoryCap();
  });

  socket.addEventListener('message', (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    onMessage(msg);
  });

  socket.addEventListener('close', () => {
    setConn(false);
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 1.6, 10000);
  });
  socket.addEventListener('error', () => { try { socket.close(); } catch {} });
}

function send(obj) {
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(obj));
}

function onMessage(msg) {
  switch (msg.type) {
    case 'all_scripts':
      scripts.clear();
      for (const s of msg.scripts) scripts.set(s.filename, s);
      renderList();
      if (current && scripts.has(current)) openScript(current, true);
      tryOpenPending();
      break;

    case 'script_changed': {
      const s = msg.script;
      scripts.set(s.filename, s);
      renderList();
      // Live-reload the open editor only if the user has no unsaved edits.
      if (current === s.filename) {
        if (!dirty) {
          loadIntoEditor(s);
          flashStatus('reloaded from disk', '#58a6ff');
        } else {
          flashStatus('disk changed — your edits kept', '#d29922');
        }
      }
      break;
    }

    case 'script_deleted':
      scripts.delete(msg.filename);
      renderList();
      if (current === msg.filename) clearEditor();
      break;

    case 'update_ack':
      if (msg.script) {
        scripts.set(msg.script.filename, msg.script);
        // A save should re-fetch this script's icon (it may have changed).
        invalidateIcon(msg.script.icon);
        if (current === msg.script.filename) {
          // Re-render header + @match/@grant/run-at/version badges from the
          // server's fresh parse so metadata edits show immediately on save.
          refreshHeader(msg.script);
          // A just-created script is now real on disk: enable its controls.
          els.enabledBtn.hidden = false;
          els.enabledBtn.disabled = false;
          renderEnabledBtn(enabledMap[msg.script.filename] !== false);
          els.deleteBtn.disabled = false;
          els.historyBtn.hidden = false;
        }
      }
      dirty = false; updateDirty();
      markSaved();
      renderList();
      break;

    case 'delete_ack':
      scripts.delete(msg.filename);
      if (current === msg.filename) clearEditor();
      renderList();
      break;

    case 'history_list':
      if (historyFor === msg.filename) {
        historyEntries = msg.entries || [];
        renderHistoryList();
      }
      break;

    case 'history_entry':
      if (historyFor === msg.filename) {
        historyCode.set(msg.id, msg.code);
        if (historySelected === msg.id) showHistoryPreview(msg.id);
      }
      break;

    case 'history_cleared':
      if (historyFor === msg.filename) {
        historyEntries = [];
        historyCode.clear();
        historySelected = null;
        renderHistoryList();
      }
      flashStatus('history cleared', '#58a6ff');
      break;

    case 'all_history_cleared':
      historyEntries = [];
      historyCode.clear();
      historySelected = null;
      if (els.historyDialog.open) renderHistoryList();
      flashStatus('all history cleared', '#58a6ff');
      break;

    case 'error':
      flashStatus('error: ' + msg.message, '#f85149');
      break;
  }
}

/** Open a script the popup requested (once the list has loaded). */
function tryOpenPending() {
  if (!pendingOpen) return;
  const fn = pendingOpen;
  if (scripts.has(fn)) {
    pendingOpen = null;
    chrome.storage.local.remove('ms_open_script').catch(() => {});
    openScript(fn);
  }
}

function setConn(on) {
  els.conn.classList.toggle('conn--on', on);
  els.conn.classList.toggle('conn--off', !on);
  els.connLabel.textContent = on ? 'connected' : 'offline';
}

/* Icon cache → options/icons.js (loadIconCache, resolveIcon, applyListIcon, invalidateIcon). */
/* ===========================================================================
 * Script list
 * ========================================================================= */

function renderList() {
  const term = els.filter.value.trim().toLowerCase();
  const items = [...scripts.values()].sort((a, b) =>
    (a.name || a.filename).localeCompare(b.name || b.filename, undefined, { sensitivity: 'base' }));

  els.list.innerHTML = '';
  let shown = 0;
  for (const s of items) {
    if (term) {
      const haystack = [
        s.name, s.filename, s.namespace, s.description, s.icon,
        ...(s.matches || []),
      ].filter(Boolean).map(v => v.toLowerCase());
      if (!haystack.some(v => v.includes(term))) continue;
    }
    shown++;
    els.list.appendChild(listItem(s));
  }
  els.count.textContent = `${items.length} script${items.length === 1 ? '' : 's'}` +
    (term ? ` (${shown} shown)` : '');
}

function listItem(s) {
  const li = document.createElement('li');
  li.className = 'script-item';
  if (s.filename === current) li.classList.add('active');
  if (enabledMap[s.filename] === false) li.classList.add('disabled');
  li.dataset.filename = s.filename;

  const icon = document.createElement('span');
  icon.className = 'si-icon';
  applyListIcon(icon, s.icon);

  const text = document.createElement('span');
  text.className = 'si-text';
  const name = document.createElement('div');
  name.className = 'si-name'; name.textContent = s.name || s.filename;
  const file = document.createElement('div');
  file.className = 'si-file'; file.textContent = s.filename + (s.version ? ` · v${s.version}` : '');
  text.append(name, file);

  const dot = document.createElement('button');
  dot.type = 'button';
  dot.className = 'si-dot';
  const enabledNow = enabledMap[s.filename] !== false;
  dot.title = enabledNow ? 'Enabled — click to disable' : 'Disabled — click to enable';
  dot.setAttribute('aria-label', dot.title);
  // Clicking the dot toggles enable/disable WITHOUT opening the editor.
  dot.addEventListener('click', (e) => {
    e.stopPropagation();
    setEnabled(s.filename, !(enabledMap[s.filename] !== false));
  });

  li.append(icon, text, dot);
  li.addEventListener('click', () => openScript(s.filename));
  return li;
}

/* ===========================================================================
 * Editor
 * ========================================================================= */

async function openScript(filename, keepCursor) {
  if (dirty && (current !== filename || isNewDraft)) {
    if (!(await confirmDiscard(current || 'the new script'))) return;
  }
  const s = scripts.get(filename);
  if (!s) return;
  current = filename;
  isNewDraft = false;
  loadIntoEditor(s, keepCursor);
  renderList();
}

function loadIntoEditor(s, keepCursor) {
  isNewDraft = false;
  const pos = keepCursor ? els.code.selectionStart : 0;
  els.code.value = s.code || '';
  els.code.disabled = false;
  els.saveBtn.disabled = false;
  els.deleteBtn.disabled = false;
  renderEnabledBtn(enabledMap[s.filename] !== false);
  els.enabledBtn.hidden = false;
  els.enabledBtn.disabled = false;
  els.closeBtn.hidden = false;
  els.historyBtn.hidden = false;
  restoreSaveBtn();
  disarmButton(els.deleteBtn, DELETE_BTN_HTML);

  refreshHeader(s);
  dirty = false; updateDirty();
  refreshHighlight();
  if (keepCursor) { els.code.selectionStart = els.code.selectionEnd = Math.min(pos, els.code.value.length); }
  updateCursor();
}

/** Update the editor header (name, file, icon) and the metadata badge bar
 *  from a freshly parsed script record — without touching the code buffer. */
function refreshHeader(s) {
  els.headName.textContent = s.name || s.filename;
  els.headFile.textContent = s.filename;
  const wantUrl = s.icon;
  els.headIcon.hidden = true;
  resolveIcon(wantUrl).then((dataUrl) => {
    // Ignore if the user switched scripts while the icon was resolving.
    if (current !== s.filename) return;
    if (dataUrl) { els.headIcon.src = dataUrl; els.headIcon.hidden = false; }
    else els.headIcon.hidden = true;
  });
  renderMeta(s);
}

function clearEditor() {
  current = null;
  isNewDraft = false;
  els.code.value = '';
  els.code.disabled = true;
  els.highlight.innerHTML = '';
  els.gutter.textContent = '';
  els.headName.textContent = 'No script selected';
  els.headFile.textContent = '';
  els.headIcon.hidden = true;
  els.metaBar.innerHTML = '';
  els.saveBtn.disabled = true;
  restoreSaveBtn();
  disarmButton(els.deleteBtn, DELETE_BTN_HTML);
  els.deleteBtn.disabled = true;
  els.enabledBtn.hidden = true;
  els.closeBtn.hidden = true;
  els.historyBtn.hidden = true;
  dirty = false; updateDirty();
  renderList();
}

/** Reflect a script's enabled state on the header toggle button. */
function renderEnabledBtn(on) {
  els.enabledBtn.classList.toggle('is-on', on);
  els.enabledBtn.querySelector('.tlabel').textContent = on ? 'Enabled' : 'Disabled';
  els.enabledBtn.title = on ? 'Enabled — click to disable' : 'Disabled — click to enable';
}

function renderMeta(s) {
  els.metaBar.innerHTML = '';
  const chips = [];
  if (s.version) chips.push(['version', s.version]);
  if (s.runAt) chips.push(['run-at', s.runAt]);
  (s.matches || []).forEach((m) => chips.push(['@match', m]));
  (s.includes || []).forEach((m) => chips.push(['@include', m]));
  (s.grants || []).slice(0, 8).forEach((g) => chips.push(['@grant', g]));
  for (const [k, v] of chips) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    const b = document.createElement('b'); b.textContent = k;
    chip.append(b, document.createTextNode(' ' + v));
    els.metaBar.appendChild(chip);
  }
}

function updateDirty() {
  els.dirty.hidden = !dirty;
  // The header text is owned by refreshHeader()/clearEditor()/newScript().
}

/** Transient feedback (reloaded / errors / exported / …) — shown in the bottom
 *  status bar. Save success/progress is shown ON the Save button instead. */
function flashStatus(text, color) {
  els.statusMsg.textContent = text;
  els.statusMsg.style.color = color;
  clearTimeout(saveStateTimer);
  saveStateTimer = setTimeout(() => { els.statusMsg.textContent = ''; }, 4000);
}

/** Save in progress — Save button shows "Saving…". */
function markSaving() {
  clearTimeout(saveBtnTimer);
  els.saveBtn.classList.remove('is-saved');
  els.saveBtn.textContent = 'Saving…';
}

/** Save succeeded — Save button flips to "✓ Saved" for 2s, then reverts. */
function markSaved() {
  clearTimeout(saveBtnTimer);
  els.saveBtn.classList.add('is-saved');
  els.saveBtn.textContent = '✓ Saved';
  saveBtnTimer = setTimeout(restoreSaveBtn, 2000);
}

/** Restore the Save button to its default label/appearance. */
function restoreSaveBtn() {
  clearTimeout(saveBtnTimer);
  els.saveBtn.classList.remove('is-saved');
  els.saveBtn.innerHTML = SAVE_BTN_HTML;
}

/* ---- new / save / delete ---- */

/** Start a brand-new script in the editor — NO modal, NO name prompt. The
 *  filename is derived from @name (and made unique) on first save. */
async function newScript() {
  if (dirty && (current || isNewDraft)) {
    if (!(await confirmDiscard(current || 'the new script'))) return;
  }
  const { default_author: author = '' } = await chrome.storage.local.get('default_author');
  const tpl = buildNewTemplate(author);
  current = null;
  isNewDraft = true;
  els.code.value = tpl;
  els.code.disabled = false;
  els.saveBtn.disabled = false;
  els.deleteBtn.disabled = true;   // nothing on disk to delete yet
  // New scripts start ENABLED, but the toggle is live before the first save:
  // flip it to disabled here and the script is created disabled.
  draftEnabled = true;
  renderEnabledBtn(true);
  els.enabledBtn.hidden = false;
  els.enabledBtn.disabled = false;
  els.closeBtn.hidden = false;
  els.historyBtn.hidden = true;    // no history until first save
  restoreSaveBtn();
  els.headName.textContent = 'New script';
  els.headFile.textContent = '(unsaved — Ctrl+S to create)';
  els.headIcon.hidden = true;
  renderMeta(parseMetaClient(tpl));
  dirty = true; updateDirty();
  refreshHighlight();
  els.code.focus();
  // place cursor inside the IIFE body
  const idx = tpl.indexOf('// Your code here...') + '// Your code here...\n'.length;
  els.code.selectionStart = els.code.selectionEnd = idx;
  updateCursor();
  renderList();
}

function save() {
  if (els.code.disabled) return;

  if (isNewDraft) {
    const code = els.code.value;
    const meta = parseMetaClient(code);
    const base = sanitizeBase(meta.name || 'New script') || 'New script';
    const filename = uniqueFilename(base + '.user.js');
    // create_script with our derived, guaranteed-unique filename
    send({ action: 'create_script', filename, code });
    markSaving();
    // adopt the filename now so the incoming update_ack/script_changed binds to it
    current = filename;
    isNewDraft = false;
    els.headFile.textContent = filename;
    els.deleteBtn.disabled = false;
    // Honour the toggle chosen while drafting: if the user turned it off, the
    // new script is created disabled (set it before injection to avoid a flash).
    if (!draftEnabled) setEnabled(filename, false);
    return;
  }

  if (!current) return;
  send({ action: 'update_script', filename: current, code: els.code.value });
  markSaving();
}

function del() {
  if (!current) return;
  // First click arms ("Confirm?"), a second click within 4s deletes.
  armButton(els.deleteBtn, DELETE_BTN_HTML, () => {
    if (current) send({ action: 'delete_script', filename: current });
  });
}

/** Leave edit mode and return to the empty home view. */
async function closeEditor() {
  if (!current && !isNewDraft) return;
  if (dirty && !(await confirmDiscard(current || 'the new script'))) return;
  clearEditor();
}

/* ---- filename helpers ---- */

/** Minimal client-side parse of the ==UserScript== block (name + matches…). */
function parseMetaClient(code) {
  const meta = { name: null, matches: [], includes: [], excludes: [], grants: [], runAt: 'document-idle', version: null };
  const block = /==UserScript==([\s\S]*?)==\/UserScript==/.exec(code);
  if (!block) return meta;
  for (const line of block[1].split(/\r\n|\r|\n/)) {
    const m = /^\s*\/\/\s*@([\w-]+)\s+(.*?)\s*$/.exec(line);
    if (!m) continue;
    const k = m[1].toLowerCase(); const v = m[2];
    if (k === 'name' && meta.name === null) meta.name = v;
    else if (k === 'match') meta.matches.push(v);
    else if (k === 'include') meta.includes.push(v);
    else if (k === 'exclude') meta.excludes.push(v);
    else if (k === 'grant') meta.grants.push(v);
    else if (k === 'run-at') meta.runAt = v;
    else if (k === 'version') meta.version = v;
  }
  return meta;
}

/** Turn a script @name into a filesystem-safe base (matches Tampermonkey:
 *  filename-illegal characters such as | : / become "-"). */
function sanitizeBase(name) {
  return String(name)
    .replace(/[\\/:*?"<>|]/g, '-')  // filename-illegal chars -> "-" (spaces kept)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

/** Ensure the filename does not collide with an existing script; append
 *  " (1)", " (2)", … before .user.js if needed. */
function uniqueFilename(filename) {
  if (!scripts.has(filename)) return filename;
  const base = filename.replace(/\.user\.js$/, '');
  for (let n = 1; n < 1000; n++) {
    const candidate = `${base} (${n}).user.js`;
    if (!scripts.has(candidate)) return candidate;
  }
  return `${base} (${Date.now()}).user.js`;
}

/* Syntax highlighter → options/highlight.js (highlight, escapeHtml, KEYWORDS…). */
function refreshHighlight() {
  const src = els.code.value;
  els.highlight.innerHTML = highlight(src) + '\n';
  // gutter line numbers
  const lines = src.split('\n').length;
  let g = '';
  for (let k = 1; k <= lines; k++) g += k + '\n';
  els.gutter.textContent = g;
syncScroll();
}

function syncScroll() {
  els.highlight.parentElement.style.transform = '';
  els.gutter.scrollTop = els.scroll.scrollTop;
  els.gutter.style.transform = `translateY(${-els.scroll.scrollTop}px)`;
}

function updateCursor() {
  const v = els.code.value;
  const p = els.code.selectionStart;
  const upto = v.slice(0, p);
  const line = upto.split('\n').length;
  const col = p - upto.lastIndexOf('\n');
  els.pos.textContent = `Ln ${line}, Col ${col}`;
}

/* ===========================================================================
 * Editor input handling
 * ========================================================================= */

els.code.addEventListener('input', () => {
  if (!dirty && current) { dirty = true; updateDirty(); }
  refreshHighlight();
  updateCursor();
});

els.code.addEventListener('scroll', () => {
  els.highlight.parentElement.scrollTop = els.code.scrollTop;
  els.gutter.scrollTop = els.code.scrollTop;
});
els.scroll.addEventListener('scroll', () => {
  els.gutter.scrollTop = els.scroll.scrollTop;
});

els.code.addEventListener('keyup', updateCursor);
els.code.addEventListener('click', updateCursor);

// Tab inserts two spaces; Ctrl+S saves.
els.code.addEventListener('keydown', (e) => {
  if (e.key === 'Tab') {
    e.preventDefault();
    const s = els.code.selectionStart, end = els.code.selectionEnd;
    els.code.value = els.code.value.slice(0, s) + '  ' + els.code.value.slice(end);
    els.code.selectionStart = els.code.selectionEnd = s + 2;
    if (!dirty) { dirty = true; updateDirty(); }
    refreshHighlight();
  }
});

// Global Ctrl/Cmd+S → save (even if focus is outside the textarea).
window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    save();
  }
});

/* ===========================================================================
 * Toolbar wiring
 * ========================================================================= */

els.saveBtn.addEventListener('click', save);
els.deleteBtn.addEventListener('click', del);
els.closeBtn.addEventListener('click', closeEditor);
els.filter.addEventListener('input', renderList);

// Esc closes the editor (but defer to any open drawer/dialog first).
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (els.confirmDialog.open) return; // the confirm modal handles its own Esc
  if (isSettingsOpen()) { e.preventDefault(); closeSettings(); return; }
  if (els.historyDialog.open || els.importDialog.open) return; // dialogs handle Esc themselves
  if (current || isNewDraft) {
    e.preventDefault();
    closeEditor();
  }
});

// A <dialog> closing via Esc / backdrop fires 'close' — keep our state in sync.
els.historyDialog.addEventListener('close', () => {
  historyFor = null;
  disarmButton(els.historyClear, HISTORY_CLEAR_HTML);
});

els.resyncBtn.addEventListener('click', async () => {
  try { await chrome.runtime.sendMessage({ __ms_control: true, action: 'resync' }); } catch {}
  flashStatus('re-injected', '#58a6ff');
});

/** Enable/disable a script. Shared by the header toggle AND the green dot in
 *  the list, so both stay in sync. */
async function setEnabled(filename, value) {
  // Optimistic, INSTANT UI update — don't wait for the background round-trip
  // (which re-registers the script and can take a moment).
  enabledMap[filename] = value;
  if (current === filename) renderEnabledBtn(value);
  renderList();

  // Persist + (un)inject in the background, then reconcile with the truth.
  try {
    const res = await chrome.runtime.sendMessage({ __ms_control: true, action: 'set_enabled', filename, value });
    if (res && res.ok && res.data && res.data.enabled) {
      enabledMap = res.data.enabled;
      if (current === filename) renderEnabledBtn(enabledMap[filename] !== false);
      renderList();
    }
  } catch { /* background asleep — keep the optimistic state */ }
}

els.enabledBtn.addEventListener('click', () => {
  if (isNewDraft) {
    // No file on disk yet — just remember the choice and reflect it.
    draftEnabled = !draftEnabled;
    renderEnabledBtn(draftEnabled);
  } else if (current) {
    setEnabled(current, !(enabledMap[current] !== false));
  }
});

// New script: straight into the editor, no modal.
els.newBtn.addEventListener('click', newScript);

/* ===========================================================================
 * Import / Export (Tampermonkey .zip backup format)
 * ========================================================================= */

els.exportBtn.addEventListener('click', exportBackup);
els.importBtn.addEventListener('click', () => els.importFile.click());
els.importFile.addEventListener('change', () => {
  const file = els.importFile.files[0];
  els.importFile.value = ''; // allow re-importing the same file
  if (file) importBackup(file);
});
els.importClose.addEventListener('click', () => els.importDialog.close());

// Default global config emitted into exports (kept Tampermonkey-compatible).
const TM_GLOBAL_DEFAULT = {
  configMode: 100, connect_mode: 'ask', external_connect: 'all', favicon_service: 'google',
  incognito_mode: 'temporary', layout: 'default#darker', layout_user_css: '',
  notification_showUpdate: 'changelog', page_filter_mode: 'black',
  require_sri_mode: 'supported', runtime_content_mode: 'userscripts', runtime_run_in: [],
  sandbox_mode: 'default', script_cookie_access: '!httponly', script_file_access: 'externals',
  script_include_mode: 'default', webrequest_fixCSP: 'auto', webrequest_modHeaders: 'yes',
};

/** Build the Tampermonkey-style <Name>.options.json for one script. */
function buildOptionsJson(s, position) {
  return {
    options: {
      check_for_updates: false, comment: null, compat_foreach: false, compat_metadata: false,
      compat_powerful_this: null, compat_wrappedjsobject: false, compatopts_for_requires: true,
      noframes: null,
      override: {
        merge_connects: true, merge_excludes: true, merge_includes: true, merge_matches: true,
        orig_connects: [], orig_excludes: s.excludes || [], orig_includes: s.includes || [],
        orig_matches: s.matches || [], orig_noframes: null, orig_run_at: s.runAt || 'document-idle',
        orig_run_in: [], orig_tags: [], use_blockers: [], use_connects: [],
        use_excludes: [], use_includes: [], use_matches: [],
      },
      run_at: null, run_in: null, sandbox: null, tags: [], unwrap: null, user_modified: null,
    },
    settings: { enabled: enabledMap[s.filename] !== false, position },
    meta: { name: s.name || s.filename, uuid: crypto.randomUUID(), modified: Date.now() },
  };
}

/** Export every script as a Tampermonkey-compatible .zip backup. */
async function exportBackup() {
  const list = [...scripts.values()].sort((a, b) =>
    (a.name || a.filename).localeCompare(b.name || b.filename, undefined, { sensitivity: 'base' }));
  if (!list.length) { flashStatus('nothing to export', '#d29922'); return; }

  // Pull each script's stored GM values straight from chrome.storage.local.
  const valueKeys = list.map((s) => 'ms_values:' + s.filename);
  let stored = {};
  try { stored = await chrome.storage.local.get(valueKeys); } catch { /* ignore */ }

  const files = [];
  const usedBases = new Set();
  list.forEach((s, i) => {
    // Match Tampermonkey: the archive entry base name is the (sanitized) @name.
    let base = sanitizeBase(s.name || s.filename.replace(/\.user\.js$/, '')) || 'script';
    let unique = base; let n = 1;
    while (usedBases.has(unique.toLowerCase())) unique = `${base} (${n++})`;
    usedBases.add(unique.toLowerCase());

    files.push({ name: unique + '.user.js', data: s.code || '' });
    files.push({ name: unique + '.options.json', data: JSON.stringify(buildOptionsJson(s, i)) });
    files.push({
      name: unique + '.storage.json',
      data: JSON.stringify({ ts: Date.now(), data: stored['ms_values:' + s.filename] || {} }),
    });
  });
  files.push({ name: 'Tampermonkey.global.json', data: JSON.stringify(TM_GLOBAL_DEFAULT) });

  // SayScript-specific settings (ignored by Tampermonkey, restored on our import).
  let defaultAuthor = '';
  try { ({ default_author: defaultAuthor = '' } = await chrome.storage.local.get('default_author')); } catch { /* ignore */ }
  files.push({ name: 'SayScript.settings.json', data: JSON.stringify({ default_author: defaultAuthor, history_cap: historyCap }) });

  const blob = await SayZip.write(files);
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `sayscript-backup-${stamp}.zip`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  flashStatus(`exported ${list.length} script(s)`, '#3fb950');
}

/** Import a Tampermonkey (or SayScript) .zip backup. Existing scripts with
 *  the same filename are overwritten (restore semantics); GM storage values
 *  and enabled state are restored too. */
async function importBackup(file) {
  showImport('Reading backup…', '');
  resetProgress(0);
  els.importErrors.hidden = true;
  els.importErrors.innerHTML = '';

  let entries;
  try {
    entries = await SayZip.read(await file.arrayBuffer());
  } catch (e) {
    showImport('Import failed', 'Not a valid ZIP: ' + (e && e.message || e), true);
    return;
  }

  const dec = new TextDecoder();
  const byName = new Map();
  for (const e of entries) byName.set(e.name, e);

  // Restore SayScript settings (default author) if the backup carries them.
  // Optional — older / Tampermonkey backups won't have this file, and that's fine.
  const settingsEntry = byName.get('SayScript.settings.json');
  if (settingsEntry) {
    try {
      const parsed = JSON.parse(dec.decode(settingsEntry.data));
      if (parsed && typeof parsed.default_author === 'string') {
        await chrome.storage.local.set({ default_author: parsed.default_author });
        els.defaultAuthor.value = parsed.default_author;
      }
      if (parsed && parsed.history_cap != null) {
        applyHistoryCap(parsed.history_cap); // persist + push the imported limit
      }
    } catch { /* malformed settings — ignore, import continues */ }
  }

  const userJs = entries.filter((e) => e.name.endsWith('.user.js'));
  if (!userJs.length) {
    showImport('Nothing to import', 'No .user.js files were found in the archive.', true);
    return;
  }

  const total = userJs.length;
  const enabledUpdates = {};
  const failures = [];   // { name, reason }
  let done = 0;

  for (let i = 0; i < total; i++) {
    const entry = userJs[i];
    const base = entry.name.replace(/\.user\.js$/, '');
    // EVERY iteration is isolated: one bad script can never abort the run.
    try {
      const code = dec.decode(entry.data);
      showImport(`Importing… (${i + 1}/${total})`, base);
      resetProgress((i / total) * 100);

      const filename = base + '.user.js';
      const exists = scripts.has(filename);

      // Restore GM storage values BEFORE registration (sync GM_getValue seed).
      const storageEntry = byName.get(base + '.storage.json');
      if (storageEntry) {
        try {
          const parsed = JSON.parse(dec.decode(storageEntry.data));
          await chrome.storage.local.set({ ['ms_values:' + filename]: (parsed && parsed.data) || {} });
        } catch { /* malformed storage.json — skip values, keep the script */ }
      }

      // Restore enabled state from options.json (default: enabled).
      const optionsEntry = byName.get(base + '.options.json');
      if (optionsEntry) {
        try {
          const parsed = JSON.parse(dec.decode(optionsEntry.data));
          enabledUpdates[filename] = (parsed && parsed.settings && parsed.settings.enabled) !== false;
        } catch { /* ignore */ }
      }

      // Write via the server, with one retry to ride out a transient
      // disconnect / slow ack. Each write waits for the socket to be ready.
      const res = await writeScriptWithRetry(filename, code, exists);
      if (res.ok) done++;
      else failures.push({ name: entry.name, reason: res.reason });
    } catch (e) {
      failures.push({ name: entry.name, reason: String(e && e.message || e) });
      console.error('[SayScript] import failed for', entry.name, e);
    }
  }
  resetProgress(100);

  // Apply enabled states + a single resync at the end. NEVER block the UI on
  // this: the background re-registration of hundreds of scripts can be slow,
  // and if the service worker is busy/recycled the message may never resolve.
  showImport('Finalizing…', 'Applying settings and re-injecting scripts…');
  try {
    if (Object.keys(enabledUpdates).length) {
      const res = await controlMessage({ action: 'set_enabled_bulk', map: enabledUpdates }, 15000);
      if (res && res.ok) Object.assign(enabledMap, enabledUpdates);
      else Object.assign(enabledMap, enabledUpdates); // best-effort; background persists independently
    } else {
      await controlMessage({ action: 'resync' }, 15000);
    }
  } catch { /* background asleep — scripts are still written to disk */ }
  renderList();

  const summary = `${done}/${total} script(s) imported` + (failures.length ? `, ${failures.length} failed.` : '.');
  showImport(failures.length ? 'Import finished with errors' : 'Import complete', summary, true);
  if (failures.length) renderImportErrors(failures);
}

/** Write one script via the server; retries once on transient failure.
 *  Returns { ok, reason }. */
async function writeScriptWithRetry(filename, code, exists) {
  let lastReason = 'unknown error';
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!(await waitForSocket(6000))) { lastReason = 'no server connection'; continue; }
    const r = await sendAndWait(
      { action: exists ? 'update_script' : 'create_script', filename, code },
      (m) => (m.type === 'update_ack' && m.filename === filename),
      (m) => (m.type === 'error' ? (m.message || 'server error') : null),
    );
    if (r.ok) return { ok: true };
    lastReason = r.reason;
    // For create-collisions, retry as an update (overwrite).
    if (!exists && /exist/i.test(lastReason)) exists = true;
  }
  return { ok: false, reason: lastReason };
}

/** Send a control message to the background worker, resolving null if it does
 *  not answer within `ms` (so a slow/recycled service worker can't hang us). */
function controlMessage(payload, ms) {
  const send = chrome.runtime.sendMessage({ __ms_control: true, ...payload }).catch(() => null);
  const timeout = new Promise((r) => setTimeout(() => r(null), ms));
  return Promise.race([send, timeout]);
}

/** Resolve true once the dashboard socket is OPEN, or false after `ms`. */
function waitForSocket(ms) {
  if (socket && socket.readyState === WebSocket.OPEN) return Promise.resolve(true);
  return new Promise((resolve) => {
    const start = Date.now();
    const iv = setInterval(() => {
      if (socket && socket.readyState === WebSocket.OPEN) { clearInterval(iv); resolve(true); }
      else if (Date.now() - start > ms) { clearInterval(iv); resolve(false); }
    }, 100);
  });
}

/** Send a WS message; resolve { ok, reason } when the matching reply (or an
 *  error reply) arrives, or on timeout. `errorOf(m)` extracts an error string
 *  from a server message (or null if it isn't an error for this request). */
function sendAndWait(message, predicate, errorOf, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let settled = false;
    const sock = socket;
    const onMsg = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (predicate(m)) return finish({ ok: true });
      const err = errorOf && errorOf(m);
      if (err) finish({ ok: false, reason: err });
    };
    const finish = (val) => {
      if (settled) return; settled = true;
      try { sock.removeEventListener('message', onMsg); } catch {}
      clearTimeout(t);
      resolve(val);
    };
    const t = setTimeout(() => finish({ ok: false, reason: 'timeout' }), timeoutMs);
    if (!sock || sock.readyState !== WebSocket.OPEN) { finish({ ok: false, reason: 'socket not open' }); return; }
    sock.addEventListener('message', onMsg);
    try { sock.send(JSON.stringify(message)); }
    catch (e) { finish({ ok: false, reason: 'send failed: ' + (e && e.message || e) }); }
  });
}

function resetProgress(pct) {
  els.importProgress.hidden = false;
  els.importBar.style.width = Math.max(0, Math.min(100, pct)) + '%';
}

function renderImportErrors(failures) {
  els.importErrors.hidden = false;
  els.importErrors.innerHTML = '';
  const head = document.createElement('div');
  head.className = 'err-head';
  head.textContent = `${failures.length} script(s) could not be imported:`;
  els.importErrors.appendChild(head);
  for (const f of failures) {
    const row = document.createElement('div');
    row.className = 'err-row';
    const name = document.createElement('div'); name.className = 'err-name'; name.textContent = f.name;
    const why = document.createElement('div'); why.className = 'err-why'; why.textContent = '↳ ' + f.reason;
    row.append(name, why);
    els.importErrors.appendChild(row);
  }
  // Also dump to console for copy/paste.
  console.group('[SayScript] Import failures (' + failures.length + ')');
  for (const f of failures) console.error(f.name, '—', f.reason);
  console.groupEnd();
}

function showImport(title, status, done) {
  els.importTitle.textContent = title;
  els.importStatus.textContent = status;
  els.importClose.disabled = !done;
  if (!els.importDialog.open) els.importDialog.showModal();
}

/* ===========================================================================
 * Settings drawer
 * ========================================================================= */

function openSettings() {
  els.settingsBackdrop.hidden = false;
  // next frame so the transition runs
  requestAnimationFrame(() => {
    els.settingsBackdrop.classList.add('open');
    els.settingsDrawer.classList.add('open');
  });
  els.settingsDrawer.setAttribute('aria-hidden', 'false');
}

function closeSettings() {
  els.settingsBackdrop.classList.remove('open');
  els.settingsDrawer.classList.remove('open');
  els.settingsDrawer.setAttribute('aria-hidden', 'true');
  resetClearAllConfirm();
  setTimeout(() => { els.settingsBackdrop.hidden = true; }, 220);
}

function isSettingsOpen() { return els.settingsDrawer.classList.contains('open'); }

els.settingsBtn.addEventListener('click', () => isSettingsOpen() ? closeSettings() : openSettings());
els.settingsClose.addEventListener('click', closeSettings);
els.settingsBackdrop.addEventListener('click', closeSettings);

/* ---- clear ALL history (double confirm: must type "confirm") ---- */

function resetClearAllConfirm() {
  els.clearAllConfirm.hidden = true;
  els.clearAllInput.value = '';
  els.clearAllDo.disabled = true;
  els.clearAllBtn.hidden = false;
}

els.clearAllBtn.addEventListener('click', () => {
  els.clearAllBtn.hidden = true;
  els.clearAllConfirm.hidden = false;
  els.clearAllInput.value = '';
  els.clearAllDo.disabled = true;
  els.clearAllInput.focus();
});
els.clearAllCancel.addEventListener('click', resetClearAllConfirm);
els.clearAllInput.addEventListener('input', () => {
  els.clearAllDo.disabled = els.clearAllInput.value.trim().toLowerCase() !== 'confirm';
});
els.clearAllInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !els.clearAllDo.disabled) els.clearAllDo.click();
});
els.clearAllDo.addEventListener('click', () => {
  if (els.clearAllInput.value.trim().toLowerCase() !== 'confirm') return;
  send({ action: 'clear_all_history' });
  resetClearAllConfirm();
});

/* ---- history limit (user setting, mirrored to the server) ---- */

function clampCap(n) {
  n = Math.round(Number(n));
  if (!Number.isFinite(n)) return 20;
  return Math.min(1000, Math.max(1, n));
}

function sendHistoryCap() { send({ action: 'set_history_cap', cap: historyCap }); }

function applyHistoryCap(cap, { persist = true, push = true } = {}) {
  historyCap = clampCap(cap);
  els.historyLimit.value = historyCap;
  if (persist) chrome.storage.local.set({ history_cap: historyCap }).catch(() => {});
  if (push) sendHistoryCap();
}

els.historyLimit.addEventListener('change', () => {
  applyHistoryCap(els.historyLimit.value);
  flashStatus('history limit set to ' + historyCap, '#58a6ff');
});

/* ===========================================================================
 * Version history viewer
 * ========================================================================= */

function fmtTs(ts) {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return String(ts);
  return d.toLocaleString(undefined, {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

function fmtSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  return (bytes / 1024).toFixed(1) + ' KB';
}

function openHistory() {
  if (!current) return;
  historyFor = current;
  historyEntries = [];
  historySelected = null;
  historyCode.clear();
  els.historyFile.textContent = current;
  els.historyPreview.innerHTML = '';
  els.historyMeta.textContent = '';
  els.historyRestore.disabled = true;
  disarmButton(els.historyClear, HISTORY_CLEAR_HTML);
  renderHistoryList();
  if (!els.historyDialog.open) els.historyDialog.showModal();
  send({ action: 'fetch_history', filename: current });
}

function closeHistory() {
  if (els.historyDialog.open) els.historyDialog.close();
  historyFor = null;
}

function renderHistoryList() {
  els.historyList.innerHTML = '';
  els.historyEmpty.hidden = historyEntries.length > 0;
  els.historyClear.disabled = historyEntries.length === 0;
  historyEntries.forEach((e, i) => {
    const li = document.createElement('li');
    li.className = 'history-item' + (e.id === historySelected ? ' active' : '');
    const when = document.createElement('div');
    when.className = 'hi-when';
    when.textContent = fmtTs(e.ts);
    const sub = document.createElement('div');
    sub.className = 'hi-sub';
    sub.textContent = (i === 0 ? 'latest · ' : '') + fmtSize(e.size);
    li.append(when, sub);
    li.addEventListener('click', () => selectHistory(e.id));
    els.historyList.appendChild(li);
  });
  // Auto-select newest version on first load.
  if (!historySelected && historyEntries.length) selectHistory(historyEntries[0].id);
}

function selectHistory(id) {
  historySelected = id;
  renderHistoryList();
  const entry = historyEntries.find((e) => e.id === id);
  els.historyMeta.textContent = entry ? fmtTs(entry.ts) + ' · ' + fmtSize(entry.size) : '';
  els.historyRestore.disabled = false;
  if (historyCode.has(id)) showHistoryPreview(id);
  else {
    els.historyPreview.textContent = 'Loading…';
    send({ action: 'fetch_history_entry', filename: historyFor, id });
  }
}

function showHistoryPreview(id) {
  els.historyPreview.innerHTML = highlight(historyCode.get(id) || '');
}

function restoreHistory() {
  if (!historySelected || !historyCode.has(historySelected)) return;
  const code = historyCode.get(historySelected);
  closeHistory();
  // Load into the editor as an unsaved change — the user reviews, then Ctrl+S.
  els.code.value = code;
  els.code.disabled = false;
  dirty = true; updateDirty();
  refreshHighlight();
  updateCursor();
  flashStatus('version restored — Ctrl+S to keep', '#d29922');
}

function clearCurrentHistory() {
  if (!historyFor) return;
  armButton(els.historyClear, HISTORY_CLEAR_HTML, () => {
    if (historyFor) send({ action: 'clear_history', filename: historyFor });
  });
}

els.historyBtn.addEventListener('click', openHistory);
els.historyClose.addEventListener('click', closeHistory);
els.historyCloseX.addEventListener('click', closeHistory);
els.historyRestore.addEventListener('click', restoreHistory);
els.historyClear.addEventListener('click', clearCurrentHistory);

/* ===========================================================================
 * Boot
 * ========================================================================= */

async function syncEnabledFromBackground() {
  try {
    const res = await chrome.runtime.sendMessage({ __ms_control: true, action: 'get_status' });
    if (res && res.ok) { enabledMap = res.data.enabled || {}; }
  } catch { /* background may be asleep; defaults to enabled */ }
}

(async function init() {
  els.serverInfo.textContent = WS_URL;

  const stored = await chrome.storage.local.get(['default_author', 'history_cap', 'ms_open_script']);
  els.defaultAuthor.value = stored.default_author || '';
  // Don't push yet — connect()'s open handler sends the cap once the socket is up.
  applyHistoryCap(stored.history_cap ?? 20, { persist: false, push: false });
  els.defaultAuthor.addEventListener('change', () => {
    chrome.storage.local.set({ default_author: els.defaultAuthor.value.trim() });
  });

  // The popup can ask us to jump straight into editing a specific script.
  if (stored.ms_open_script) pendingOpen = stored.ms_open_script;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.ms_open_script && changes.ms_open_script.newValue) {
      pendingOpen = changes.ms_open_script.newValue;
      tryOpenPending();
    }
  });

  await Promise.all([syncEnabledFromBackground(), loadIconCache()]);
  clearEditor();
  connect();
  tryOpenPending();
})();
