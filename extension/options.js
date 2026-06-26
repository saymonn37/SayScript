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

const WS_URL = 'ws://localhost:3000';

/* ---------------- DOM refs ---------------- */
const $ = (id) => document.getElementById(id);
const els = {
  conn: $('conn'), connLabel: $('conn-label'),
  filter: $('filter'), list: $('script-list'), count: $('count'),
  newBtn: $('new-btn'), resyncBtn: $('resync-btn'),
  headIcon: $('head-icon'), headName: $('head-name'), headFile: $('head-file'),
  enabled: $('head-enabled'), enabledToggle: $('enabled-toggle'),
  dirty: $('dirty'), saveState: $('save-state'),
  saveBtn: $('save-btn'), deleteBtn: $('delete-btn'), closeBtn: $('close-btn'),
  metaBar: $('meta-bar'),
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

/* Template used for a brand-new script (no modal, no name prompt). */
const NEW_TEMPLATE =
  '// ==UserScript==\n' +
  '// @name        New script\n' +
  '// @namespace   sayscript\n' +
  '// @version     1.0.0\n' +
  '// @description \n' +
  '// @match       *://*/*\n' +
  '// @grant       none\n' +
  '// @run-at      document-idle\n' +
  '// ==/UserScript==\n\n' +
  "(function () {\n  'use strict';\n\n})();\n";

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
      break;

    case 'script_changed': {
      const s = msg.script;
      scripts.set(s.filename, s);
      renderList();
      // Live-reload the open editor only if the user has no unsaved edits.
      if (current === s.filename) {
        if (!dirty) {
          loadIntoEditor(s);
          flashSave('reloaded from disk', '#58a6ff');
        } else {
          flashSave('disk changed — your edits kept', '#d29922');
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
        if (current === msg.script.filename) {
          // Re-render header + @match/@grant/run-at/version badges from the
          // server's fresh parse so metadata edits show immediately on save.
          refreshHeader(msg.script);
          // A just-created script is now real on disk: enable its controls.
          els.enabledToggle.hidden = false;
          els.enabled.disabled = false;
          els.enabled.checked = enabledMap[msg.script.filename] !== false;
          els.deleteBtn.disabled = false;
        }
      }
      dirty = false; updateDirty();
      flashSave('saved ✓', '#3fb950');
      renderList();
      break;

    case 'delete_ack':
      scripts.delete(msg.filename);
      if (current === msg.filename) clearEditor();
      renderList();
      break;

    case 'error':
      flashSave('error: ' + msg.message, '#f85149');
      break;
  }
}

function setConn(on) {
  els.conn.classList.toggle('conn--on', on);
  els.conn.classList.toggle('conn--off', !on);
  els.connLabel.textContent = on ? 'connected' : 'offline';
}

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
    if (term && !(s.name || '').toLowerCase().includes(term) && !s.filename.toLowerCase().includes(term)) continue;
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
  if (s.icon && /^https?:|^data:/.test(s.icon)) {
    const img = document.createElement('img');
    img.src = s.icon; img.alt = ''; img.width = 18; img.height = 18;
    img.style.cssText = 'width:18px;height:18px;object-fit:contain;border-radius:4px';
    img.onerror = () => { icon.textContent = '📜'; };
    icon.appendChild(img);
  } else {
    icon.textContent = '📜';
  }

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

function openScript(filename, keepCursor) {
  if (dirty && (current !== filename || isNewDraft)) {
    if (!confirm('Discard unsaved changes to ' + (current || 'the new script') + '?')) return;
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
  els.enabled.disabled = false;
  els.enabled.checked = enabledMap[s.filename] !== false;
  els.enabledToggle.hidden = false;
  els.closeBtn.hidden = false;

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
  if (s.icon && /^https?:|^data:/.test(s.icon)) {
    els.headIcon.src = s.icon; els.headIcon.hidden = false;
    els.headIcon.onerror = () => { els.headIcon.hidden = true; };
  } else {
    els.headIcon.hidden = true;
  }
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
  els.deleteBtn.disabled = true;
  els.enabled.disabled = true;
  els.enabledToggle.hidden = true;
  els.closeBtn.hidden = true;
  dirty = false; updateDirty();
  renderList();
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

function flashSave(text, color) {
  els.saveState.textContent = text;
  els.saveState.style.color = color;
  clearTimeout(saveStateTimer);
  saveStateTimer = setTimeout(() => { els.saveState.textContent = ''; }, 4000);
}

/* ---- new / save / delete ---- */

/** Start a brand-new script in the editor — NO modal, NO name prompt. The
 *  filename is derived from @name (and made unique) on first save. */
function newScript() {
  if ((dirty || isNewDraft) && (current || isNewDraft)) {
    const what = current || 'the new script';
    if (dirty && !confirm('Discard unsaved changes to ' + what + '?')) return;
  }
  current = null;
  isNewDraft = true;
  els.code.value = NEW_TEMPLATE;
  els.code.disabled = false;
  els.saveBtn.disabled = false;
  els.deleteBtn.disabled = true;   // nothing on disk to delete yet
  els.enabled.disabled = true;
  els.enabledToggle.hidden = true; // no enabled state until saved
  els.closeBtn.hidden = false;
  els.headName.textContent = 'New script';
  els.headFile.textContent = '(unsaved — Ctrl+S to create)';
  els.headIcon.hidden = true;
  renderMeta(parseMetaClient(NEW_TEMPLATE));
  dirty = true; updateDirty();
  refreshHighlight();
  els.code.focus();
  // place cursor inside the IIFE body
  const idx = NEW_TEMPLATE.indexOf("'use strict';") + "'use strict';\n\n".length;
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
    flashSave('creating…', '#8b949e');
    // adopt the filename now so the incoming update_ack/script_changed binds to it
    current = filename;
    isNewDraft = false;
    els.headFile.textContent = filename;
    els.deleteBtn.disabled = false;
    return;
  }

  if (!current) return;
  send({ action: 'update_script', filename: current, code: els.code.value });
  flashSave('saving…', '#8b949e');
}

function del() {
  if (!current) return;
  if (!confirm('Delete ' + current + ' from disk? This cannot be undone.')) return;
  send({ action: 'delete_script', filename: current });
}

/** Leave edit mode and return to the empty home view. */
function closeEditor() {
  if (!current && !isNewDraft) return;
  if (dirty && !confirm('Discard unsaved changes to ' + (current || 'the new script') + '?')) return;
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

/* ===========================================================================
 * Syntax highlighting (self-contained tokenizer — no external libs)
 * ========================================================================= */

const KEYWORDS = new Set(('break case catch class const continue debugger default delete do else ' +
  'export extends finally for function if import in instanceof let new return super switch this throw ' +
  'try typeof var void while with yield async await of static get set').split(' '));
const LITERALS = new Set('true false null undefined NaN Infinity'.split(' '));
const GM_IDENT = /^(GM_\w+|GM|unsafeWindow)$/;

function escapeHtml(s) {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

/**
 * Tokenize JavaScript into highlighted HTML. Handles line/block comments,
 * single/double/template strings, regex literals (heuristic), numbers,
 * identifiers/keywords, and the UserScript metadata block.
 */
function highlight(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let prevSignificant = ''; // last non-space token text, to disambiguate regex vs divide

  // metadata block gets a flat highlight first if present at the very top
  while (i < n) {
    const c = src[i];

    // line comment
    if (c === '/' && src[i + 1] === '/') {
      let j = src.indexOf('\n', i); if (j === -1) j = n;
      const seg = src.slice(i, j);
      const cls = /@\w/.test(seg) ? 'tok-meta' : 'tok-comment';
      out += `<span class="${cls}">${escapeHtml(seg)}</span>`;
      i = j; continue;
    }
    // block comment
    if (c === '/' && src[i + 1] === '*') {
      let j = src.indexOf('*/', i + 2); j = (j === -1) ? n : j + 2;
      out += `<span class="tok-comment">${escapeHtml(src.slice(i, j))}</span>`;
      i = j; continue;
    }
    // strings
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n) { if (src[j] === '\\') j += 2; else if (src[j] === c) { j++; break; } else j++; }
      out += `<span class="tok-string">${escapeHtml(src.slice(i, j))}</span>`;
      i = j; prevSignificant = 'str'; continue;
    }
    // template literal
    if (c === '`') {
      let j = i + 1;
      while (j < n) { if (src[j] === '\\') j += 2; else if (src[j] === '`') { j++; break; } else j++; }
      out += `<span class="tok-template">${escapeHtml(src.slice(i, j))}</span>`;
      i = j; prevSignificant = 'str'; continue;
    }
    // regex literal (heuristic: only when a value cannot precede)
    if (c === '/' && regexAllowed(prevSignificant)) {
      let j = i + 1, inClass = false, ok = false;
      while (j < n) {
        const d = src[j];
        if (d === '\\') { j += 2; continue; }
        if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) { j++; ok = true; break; }
        else if (d === '\n') break;
        j++;
      }
      if (ok) {
        while (j < n && /[a-z]/i.test(src[j])) j++; // flags
        out += `<span class="tok-regex">${escapeHtml(src.slice(i, j))}</span>`;
        i = j; prevSignificant = 'regex'; continue;
      }
    }
    // numbers
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] || ''))) {
      let j = i;
      while (j < n && /[0-9a-fxob_.eE+\-]/.test(src[j])) {
        if ((src[j] === '+' || src[j] === '-') && !/[eE]/.test(src[j - 1])) break;
        j++;
      }
      out += `<span class="tok-number">${escapeHtml(src.slice(i, j))}</span>`;
      i = j; prevSignificant = 'num'; continue;
    }
    // identifiers / keywords
    if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$]/.test(src[j])) j++;
      const word = src.slice(i, j);
      let cls = '';
      if (KEYWORDS.has(word)) cls = 'tok-keyword';
      else if (LITERALS.has(word)) cls = 'tok-bool';
      else if (GM_IDENT.test(word)) cls = 'tok-gm';
      else if (src[j] === '(' || (skipSpace(src, j) === '(')) cls = 'tok-func';
      out += cls ? `<span class="${cls}">${escapeHtml(word)}</span>` : escapeHtml(word);
      i = j; prevSignificant = word; continue;
    }
    // whitespace
    if (/\s/.test(c)) { out += c; i++; continue; }
    // punctuation
    out += `<span class="tok-punct">${escapeHtml(c)}</span>`;
    i++;
    if (!/\s/.test(c)) prevSignificant = c;
  }
  return out;
}

function regexAllowed(prev) {
  if (prev === '' ) return true;
  if (prev === 'str' || prev === 'num' || prev === 'regex') return false;
  if (/^[A-Za-z0-9_$]+$/.test(prev)) {
    return KEYWORDS.has(prev); // after `return`, `typeof`, etc. a regex is fine
  }
  return !(prev === ')' || prev === ']'); // after these a `/` is division
}
function skipSpace(src, j) { while (j < src.length && /\s/.test(src[j])) j++; return src[j]; }

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

// Esc closes the editor.
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && (current || isNewDraft) && !els.importDialog.open) {
    e.preventDefault();
    closeEditor();
  }
});

els.resyncBtn.addEventListener('click', async () => {
  try { await chrome.runtime.sendMessage({ __ms_control: true, action: 'resync' }); } catch {}
  flashSave('re-injected', '#58a6ff');
});

/** Enable/disable a script. Shared by the header toggle AND the green dot in
 *  the list, so both stay in sync. */
async function setEnabled(filename, value) {
  // Optimistic, INSTANT UI update — don't wait for the background round-trip
  // (which re-registers the script and can take a moment).
  enabledMap[filename] = value;
  if (current === filename) els.enabled.checked = value;
  renderList();

  // Persist + (un)inject in the background, then reconcile with the truth.
  try {
    const res = await chrome.runtime.sendMessage({ __ms_control: true, action: 'set_enabled', filename, value });
    if (res && res.ok && res.data && res.data.enabled) {
      enabledMap = res.data.enabled;
      if (current === filename) els.enabled.checked = enabledMap[filename] !== false;
      renderList();
    }
  } catch { /* background asleep — keep the optimistic state */ }
}

els.enabled.addEventListener('change', () => {
  if (current) setEnabled(current, els.enabled.checked);
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
  if (!list.length) { flashSave('nothing to export', '#d29922'); return; }

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

  const blob = await SayZip.write(files);
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `sayscript-backup-${stamp}.zip`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  flashSave(`exported ${list.length} script(s)`, '#3fb950');
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
  await syncEnabledFromBackground();
  clearEditor();
  connect();
})();
