/* ==========================================================================
 * SayScript — background service worker (MV3, module).
 *
 *   - Maintains a resilient WebSocket connection to the PHP server
 *     (ws://localhost:8165) with automatic reconnect + keepalive.
 *   - Keeps the script set in memory + chrome.storage.local (survives the SW
 *     being torn down).
 *   - Registers every enabled script with chrome.userScripts so the browser
 *     injects them — CSP-exempt, with the GM polyfill prepended.
 *   - Services GM_xmlhttpRequest (via fetch — bypasses page CORS) and the
 *     GM storage messages coming back from the userscript world.
 * ======================================================================== */

const WS_URL = 'ws://localhost:8165';

/* -------------------------- in-memory state ------------------------------ */

const state = {
  scripts: new Map(),     // filename -> script record from the server
  enabled: {},            // filename -> bool (default true), persisted
  connected: false,
};

let socket = null;
let reconnectTimer = null;
let reconnectDelay = 1000;       // backoff, capped
let keepAliveTimer = null;
let polyfillSource = '';         // gm-polyfill.js text, loaded once

/* -------------------------- persistence ---------------------------------- */

async function loadState() {
  const data = await chrome.storage.local.get(['ms_scripts', 'ms_enabled']);
  state.enabled = data.ms_enabled || {};
  if (Array.isArray(data.ms_scripts)) {
    for (const s of data.ms_scripts) state.scripts.set(s.filename, s);
  }
}

async function persistScripts() {
  await chrome.storage.local.set({ ms_scripts: [...state.scripts.values()] });
}

async function persistEnabled() {
  await chrome.storage.local.set({ ms_enabled: state.enabled });
}

function isEnabled(filename) {
  return state.enabled[filename] !== false; // default ON
}

/* -------------------------- polyfill loader ------------------------------ */

async function loadPolyfill() {
  if (polyfillSource) return polyfillSource;
  const res = await fetch(chrome.runtime.getURL('gm-polyfill.js'));
  polyfillSource = await res.text();
  return polyfillSource;
}

/* -------------------------- GM value storage ----------------------------- */
/* GM values are stored per script under `ms_values:<filename>` and embedded
 * (synchronously) into the injected preamble so GM_getValue is sync. */

async function getValuesFor(filename) {
  const key = 'ms_values:' + filename;
  const data = await chrome.storage.local.get(key);
  return data[key] || {};
}

async function setValueFor(filename, k, v) {
  const values = await getValuesFor(filename);
  values[k] = v;
  await chrome.storage.local.set({ ['ms_values:' + filename]: values });
}

async function deleteValueFor(filename, k) {
  const values = await getValuesFor(filename);
  delete values[k];
  await chrome.storage.local.set({ ['ms_values:' + filename]: values });
}

/* -------------------------- userScripts injection ------------------------ */

/** Convert a Tampermonkey @match to a chrome match pattern (passthrough). */
function normalizeMatches(matches) {
  return (matches || []).filter(Boolean);
}

/** Convert a Tampermonkey @include into an include glob. Regex includes
 *  (`/.../`) are not expressible as globs — we map them to broad globs and
 *  log, rather than silently dropping coverage. */
function includeToGlobs(includes) {
  const globs = [];
  for (const inc of includes || []) {
    if (!inc) continue;
    if (inc === '*') { globs.push('*'); continue; }
    if (inc.startsWith('/') && inc.endsWith('/')) {
      // regex include — approximate; userScripts has no regex match support.
      console.warn('[SayScript] regex @include approximated as "*://*/*":', inc);
      globs.push('*://*/*');
      continue;
    }
    // bare host like "example.com" → cover the whole host
    globs.push(/^[a-z]+:\/\//i.test(inc) ? inc : '*' + inc + '*');
  }
  return globs;
}

function runAtToChrome(runAt) {
  switch ((runAt || '').toLowerCase()) {
    case 'document-start': return 'document_start';
    case 'document-end':   return 'document_end';
    case 'document-body':  return 'document_start';
    default:               return 'document_idle';
  }
}

/** Build the registration object for one script (or null if unusable). */
async function buildRegistration(script) {
  const matches = normalizeMatches(script.matches);
  const globs   = includeToGlobs(script.includes);

  // userScripts.register requires `matches`. If a script only used @include,
  // fall back to <all_urls> and let the include globs narrow it.
  const finalMatches = matches.length ? matches : ['*://*/*'];

  const values = await getValuesFor(script.filename);
  const info = {
    name: script.name,
    namespace: script.namespace || '',
    version: script.version || '',
    description: script.description || '',
  };

  const preamble =
    'const __MS_SCRIPT_ID__ = ' + JSON.stringify(script.filename) + ';\n' +
    'const __MS_INITIAL_VALUES__ = ' + JSON.stringify(values) + ';\n' +
    'const __MS_SCRIPT_INFO__ = ' + JSON.stringify(info) + ';\n';

  // CRITICAL: every userscript in the USER_SCRIPT world shares ONE top-level
  // lexical scope. Declaring the preamble consts at program top-level made the
  // SECOND matching script on a page throw "Identifier '__MS_SCRIPT_ID__' has
  // already been declared". Wrapping each script (preamble + polyfill + user
  // code) in its own IIFE gives it a private scope — which also isolates every
  // userscript's own top-level declarations from the others, like Tampermonkey.
  // No outer "use strict": let each userscript keep its original (often sloppy) mode.
  const wrapped =
    '(function () {\n' +
    preamble +
    polyfillSource + '\n;\n' +
    script.code + '\n' +
    '\n})();';

  const reg = {
    id: 'ms:' + script.filename,
    matches: finalMatches,
    js: [{ code: wrapped }],
    runAt: runAtToChrome(script.runAt),
    world: 'USER_SCRIPT',
    allFrames: false,
  };
  if (globs.length) reg.includeGlobs = globs;
  if (script.excludes && script.excludes.length) reg.excludeGlobs = includeToGlobs(script.excludes);
  return reg;
}

// Serialize all (re)registration so concurrent callers (boot + WS all_scripts)
// can't both read an empty list and then register the same ID twice.
let syncChain = Promise.resolve();
function syncRegistrations() {
  syncChain = syncChain.then(doSyncRegistrations, doSyncRegistrations);
  return syncChain;
}

/** Tear down and re-register every enabled script. */
async function doSyncRegistrations() {
  if (!chrome.userScripts) {
    console.error('[SayScript] chrome.userScripts unavailable. Enable "Allow user scripts" ' +
      'in the extension details page (chrome://extensions).');
    return;
  }

  await loadPolyfill();

  // Make chrome.runtime messaging available inside the USER_SCRIPT world.
  try {
    await chrome.userScripts.configureWorld({ messaging: true });
  } catch (e) {
    console.warn('[SayScript] configureWorld failed:', e);
  }

  // Clear previous registrations owned by us.
  try {
    const existing = await chrome.userScripts.getScripts();
    if (existing.length) {
      await chrome.userScripts.unregister({ ids: existing.map((s) => s.id) });
    }
  } catch (e) {
    console.warn('[SayScript] unregister failed:', e);
  }

  const regs = [];
  for (const script of state.scripts.values()) {
    if (!isEnabled(script.filename)) continue;
    try {
      regs.push(await buildRegistration(script));
    } catch (e) {
      console.warn('[SayScript] build registration failed for', script.filename, e);
    }
  }

  // Register one at a time so a single malformed @match doesn't sink the batch.
  let ok = 0;
  for (const reg of regs) {
    try {
      await chrome.userScripts.register([reg]);
      ok++;
    } catch (e) {
      console.warn('[SayScript] register failed for', reg.id, '-', e.message);
    }
  }
  console.log(`[SayScript] registered ${ok}/${regs.length} script(s).`);
  await updateBadge();
}

/** Register/unregister a SINGLE script (fast path for enable/disable toggles).
 *  Runs on the same serialized chain so it can't race a full re-registration. */
function applyOneRegistration(filename, enabled) {
  syncChain = syncChain.then(() => doApplyOne(filename, enabled), () => doApplyOne(filename, enabled));
  return syncChain;
}

async function doApplyOne(filename, enabled) {
  if (!chrome.userScripts) return;
  const id = 'ms:' + filename;
  try {
    if (enabled) {
      const script = state.scripts.get(filename);
      if (!script) return;
      await loadPolyfill();
      try { await chrome.userScripts.unregister({ ids: [id] }); } catch { /* wasn't registered */ }
      await chrome.userScripts.register([await buildRegistration(script)]);
    } else {
      try { await chrome.userScripts.unregister({ ids: [id] }); } catch { /* already gone */ }
    }
  } catch (e) {
    console.warn('[SayScript] toggle registration failed for', filename, e);
  }
  await updateBadge();
}

/* -------------------------- URL matching --------------------------------- */
/* Used to decide which scripts apply to a given tab (for the per-tab badge
 * count and the toolbar popup). Mirrors Tampermonkey's OR semantics:
 * a script applies if any @match OR any @include matches, minus @exclude. */

function globToRegexSource(glob) {
  return glob.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
}

function matchPatternMatches(pattern, u) {
  if (pattern === '<all_urls>') return /^(https?|file|ftp|wss?):$/.test(u.protocol);
  const m = /^([^:]+):\/\/([^/]*)(\/.*)?$/.exec(pattern);
  if (!m) return false;
  const scheme = m[1];
  const host = m[2];
  const path = m[3] || '/*';
  const proto = u.protocol.replace(':', '');
  if (scheme === '*') { if (proto !== 'http' && proto !== 'https') return false; }
  else if (scheme !== proto) return false;

  if (host && host !== '*') {
    // Chrome semantics: "*.example.com" matches example.com AND any subdomain.
    // Tampermonkey also allows ports in the host part (localhost:8000, jj.local:*).
    const hostSrc = host.startsWith('*.')
      ? '(?:.*\\.)?' + host.slice(2).replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      : globToRegexSource(host);
    const hostRx = new RegExp('^' + hostSrc + '$', 'i');
    if (!hostRx.test(u.host) && !hostRx.test(u.hostname)) return false;
  }
  const target = u.pathname + (u.search || '');
  const pathRx = new RegExp('^' + globToRegexSource(path) + '$');
  if (!pathRx.test(target) && !pathRx.test(u.pathname)) return false;
  return true;
}

function includeMatches(inc, url) {
  if (inc === '*' || inc === '*://*/*') return true;
  if (inc.length > 2 && inc[0] === '/' && inc.endsWith('/')) {
    try { return new RegExp(inc.slice(1, -1)).test(url); } catch { return false; }
  }
  let g = inc;
  if (!/:\/\//.test(g) && g[0] !== '*') g = '*' + g + '*';
  try { return new RegExp('^' + globToRegexSource(g) + '$', 'i').test(url); } catch { return false; }
}

/** Does this script apply to `url`? */
function scriptMatchesUrl(script, url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (!/^(https?|file|ftp|wss?):$/.test(u.protocol)) return false;

  const excludes = script.excludes || [];
  if (excludes.some((e) => includeMatches(e, url) || matchPatternMatches(e, u))) return false;

  const matches = script.matches || [];
  const includes = script.includes || [];
  if (matches.length === 0 && includes.length === 0) return false;
  if (matches.some((m) => matchPatternMatches(m, u))) return true;
  if (includes.some((i) => includeMatches(i, url))) return true;
  return false;
}

/** Scripts that apply to `url`, with their enabled flag. */
function scriptsForUrl(url) {
  const out = [];
  for (const s of state.scripts.values()) {
    if (scriptMatchesUrl(s, url)) {
      out.push({
        filename: s.filename,
        name: s.name || s.filename,
        icon: s.icon || null,
        version: s.version || '',
        enabled: isEnabled(s.filename),
      });
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  return out;
}

/* -------------------------- badge ---------------------------------------- */

/** The badge text is PER TAB: number of ENABLED scripts that run on that tab. */
async function updateTabBadge(tabId, url) {
  let text = '';
  if (url) {
    const count = scriptsForUrl(url).filter((s) => s.enabled).length;
    text = count ? String(count) : '';
  }
  try {
    await chrome.action.setBadgeText({ tabId, text });
  } catch { /* tab may have closed */ }
}

/** Recompute badges for every open tab (after script/enabled changes). */
async function updateAllBadges() {
  try {
    await chrome.action.setBadgeBackgroundColor({ color: state.connected ? '#3fb950' : '#888' });
    const tabs = await chrome.tabs.query({});
    await Promise.all(tabs.map((t) => updateTabBadge(t.id, t.url)));
  } catch { /* ignore */ }
}

// Kept for older call-sites: now just refreshes colour + all tab badges.
async function updateBadge() {
  await updateAllBadges();
}

// Re-badge tabs as they navigate / become active.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'loading' || changeInfo.url) {
    updateTabBadge(tabId, changeInfo.url || tab.url);
  }
});
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try { const tab = await chrome.tabs.get(tabId); updateTabBadge(tabId, tab.url); } catch {}
});

/* -------------------------- WebSocket client ----------------------------- */

function connect() {
  clearTimeout(reconnectTimer);

  // Never open a second socket if one is already live or handshaking.
  if (socket && (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)) {
    return;
  }

  let ws;
  try {
    ws = new WebSocket(WS_URL);
  } catch (e) {
    scheduleReconnect();
    return;
  }
  socket = ws;

  // Reference `ws` (not the module-level `socket`) inside handlers so a later
  // connect() can't make this handler act on a different socket.
  ws.addEventListener('open', () => {
    if (socket !== ws) { try { ws.close(); } catch {} return; } // superseded
    console.log('[SayScript] connected to', WS_URL);
    state.connected = true;
    reconnectDelay = 1000;
    ws.send(JSON.stringify({ action: 'fetch_all_scripts' }));
    startKeepAlive();
    updateBadge();
  });

  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    handleServerMessage(msg);
  });

  ws.addEventListener('close', () => {
    if (socket !== ws) return; // a newer socket already took over
    state.connected = false;
    stopKeepAlive();
    updateBadge();
    scheduleReconnect();
  });

  ws.addEventListener('error', () => {
    try { ws.close(); } catch { /* ignore */ }
  });
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 1.6, 15000);
}

function startKeepAlive() {
  stopKeepAlive();
  // Traffic keeps both the socket and the MV3 service worker alive.
  keepAliveTimer = setInterval(() => {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ action: 'ping' }));
    }
  }, 20000);
}

function stopKeepAlive() {
  if (keepAliveTimer) { clearInterval(keepAliveTimer); keepAliveTimer = null; }
}

// Coalesce bursts of script changes (e.g. importing 271 scripts → 271
// script_changed events) into a SINGLE persist + re-registration. Without this
// debounce each event triggered a full unregister+register of every script —
// O(n²) work that made the service worker fall hopelessly behind and hang.
let changeDebounce = null;
function scheduleApplyChanges(delayMs) {
  clearTimeout(changeDebounce);
  changeDebounce = setTimeout(() => {
    changeDebounce = null;
    persistScripts().catch(() => {});
    syncRegistrations();
  }, delayMs);
}

async function handleServerMessage(msg) {
  switch (msg.type) {
    case 'all_scripts':
      state.scripts.clear();
      for (const s of msg.scripts) state.scripts.set(s.filename, s);
      // Initial load: apply promptly, but still debounced so a reconnect storm
      // doesn't double-register.
      scheduleApplyChanges(150);
      break;

    case 'script_changed':
      state.scripts.set(msg.script.filename, msg.script);
      scheduleApplyChanges(500);
      break;

    case 'script_deleted':
      state.scripts.delete(msg.filename);
      scheduleApplyChanges(500);
      break;

    case 'pong':
    case 'update_ack':
    case 'delete_ack':
      break;
  }
}

/* -------------------------- message router ------------------------------- */

// GM bridge messages from the USER_SCRIPT world DO NOT arrive on
// chrome.runtime.onMessage — the userScripts messaging API dispatches them to
// a dedicated channel: chrome.runtime.onUserScriptMessage. This is what makes
// GM_xmlhttpRequest (CORS-free fetch), GM_setValue, etc. work.
function gmListener(msg, sender, sendResponse) {
  if (!msg || !msg.__sayscript) return false;
  handleGmMessage(msg)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((err) => sendResponse({ ok: false, error: String(err && err.message || err) }));
  return true; // async
}

if (chrome.runtime.onUserScriptMessage) {
  chrome.runtime.onUserScriptMessage.addListener(gmListener);
} else {
  console.error('[SayScript] chrome.runtime.onUserScriptMessage is unavailable — ' +
    'GM_* messaging (GM_xmlhttpRequest, GM_setValue, …) cannot work. Update Chrome to 120+.');
}

// Control messages from the dashboard / options page arrive on onMessage.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // ---- dashboard / options page control ----
  if (msg && msg.__ms_control) {
    handleControl(msg)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) => sendResponse({ ok: false, error: String(err && err.message || err) }));
    return true;
  }
});

async function handleGmMessage(msg) {
  switch (msg.type) {
    case 'GM_setValue':
      await setValueFor(msg.scriptId, msg.key, msg.value);
      return true;

    case 'GM_deleteValue':
      await deleteValueFor(msg.scriptId, msg.key);
      return true;

    case 'GM_getValuesAll':
      return getValuesFor(msg.scriptId);

    case 'GM_xmlhttpRequest':
      return doFetch(msg.details);

    default:
      throw new Error('Unknown GM message: ' + msg.type);
  }
}

async function handleControl(msg) {
  switch (msg.action) {
    case 'get_status':
      return {
        connected: state.connected,
        count: state.scripts.size,
        enabled: state.enabled,
      };
    case 'set_enabled':
      state.enabled[msg.filename] = !!msg.value;
      await persistEnabled();
      // Incremental: (un)register just THIS script — O(1), near-instant —
      // instead of rebuilding all registrations (O(n), 1-3s for hundreds).
      await applyOneRegistration(msg.filename, !!msg.value);
      return { enabled: state.enabled };
    case 'set_enabled_bulk':
      // msg.map: { filename: bool } — applied in one pass + a single resync.
      for (const [fn, val] of Object.entries(msg.map || {})) {
        state.enabled[fn] = !!val;
      }
      await persistEnabled();
      await syncRegistrations();
      return { enabled: state.enabled };
    case 'get_active_scripts':
      // Scripts that apply to a given URL (for the toolbar popup).
      return { scripts: scriptsForUrl(msg.url || ''), connected: state.connected };
    case 'resync':
      await syncRegistrations();
      return true;
    default:
      throw new Error('Unknown control action: ' + msg.action);
  }
}

/* -------------------------- background fetch (CORS bypass) ---------------- */

async function doFetch(details) {
  const controller = new AbortController();
  let timer = null;
  if (details.timeout > 0) {
    timer = setTimeout(() => controller.abort(), details.timeout);
  }

  try {
    // Credentials policy — match Tampermonkey / browser defaults:
    //   - default ('same-origin'): cookies sent only for same-origin requests,
    //     NONE for cross-origin. Forcing 'include' makes Chrome reject many
    //     cross-origin calls (e.g. POSTing JSON to a localhost API like
    //     LM Studio), which is exactly what was failing here.
    //   - `anonymous: true`        -> never send cookies ('omit')
    //   - `anonymous: false` / `withCredentials: true` -> always ('include')
    let credentials = 'same-origin';
    if (details.anonymous === true) credentials = 'omit';
    else if (details.anonymous === false || details.withCredentials === true) credentials = 'include';

    const init = {
      method: details.method,
      headers: details.headers || {},
      signal: controller.signal,
      credentials,
    };
    if (details.data != null && !['GET', 'HEAD'].includes(details.method)) {
      init.body = details.data;
    }

    let resp;
    try {
      resp = await fetch(details.url, init);
    } catch (e) {
      // Network-level failure (DNS, refused, blocked, aborted). Surface a
      // useful message to the userscript AND the service-worker console.
      const reason = (controller.signal.aborted) ? 'timeout/abort' : (e && e.message) || String(e);
      console.warn('[SayScript] GM_xmlhttpRequest fetch failed:', details.method, details.url, '-', reason);
      throw new Error('Request to ' + details.url + ' failed: ' + reason);
    }

    const headers = {};
    resp.headers.forEach((v, k) => { headers[k] = v; });
    const contentType = resp.headers.get('content-type') || '';

    const wantsBinary = details.responseType === 'arraybuffer' || details.responseType === 'blob';
    let body = '';
    let bodyBase64 = '';

    if (wantsBinary) {
      const buf = new Uint8Array(await resp.arrayBuffer());
      let bin = '';
      const CHUNK = 0x8000;
      for (let i = 0; i < buf.length; i += CHUNK) {
        bin += String.fromCharCode.apply(null, buf.subarray(i, i + CHUNK));
      }
      bodyBase64 = btoa(bin);
    } else {
      body = await resp.text();
    }

    return {
      status: resp.status,
      statusText: resp.statusText,
      headers,
      contentType,
      finalUrl: resp.url,
      body,
      bodyBase64,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/* The toolbar action shows popup.html (set in manifest); onClicked no longer
 * fires. The popup lists the scripts running on the current tab and links to
 * the dashboard. */

/* -------------------------- boot ----------------------------------------- */

// onInstalled, onStartup and the top-level call can all fire for one SW
// instance — run the actual boot only once.
let bootPromise = null;
function boot() {
  if (!bootPromise) {
    bootPromise = (async () => {
      await loadState();
      await syncRegistrations(); // register from cached state immediately
      connect();
    })();
  }
  return bootPromise;
}

chrome.runtime.onInstalled.addListener(() => boot());
chrome.runtime.onStartup.addListener(() => boot());
boot(); // also run when the SW spins up on demand
