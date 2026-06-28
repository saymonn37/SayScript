/* ==========================================================================
 * SayScript — background service worker (MV3, module entry point).
 *
 * Wires the focused modules together:
 *   - store         — in-memory state + chrome.storage persistence + GM values
 *   - matching      — which scripts apply to a URL
 *   - registration  — chrome.userScripts (un)registration
 *   - badge         — per-tab badge counts
 *   - gm-bridge     — GM_* messages + CORS-free fetch
 *   - ws-client     — WebSocket to the PHP server
 *
 * This file owns the message routers, the dashboard/popup control API, the tab
 * badge listeners, and boot.
 * ======================================================================== */

import { state, loadState, persistEnabled } from './store.js';
import { scriptsForUrl } from './matching.js';
import { syncRegistrations, applyOneRegistration } from './registration.js';
import { updateTabBadge, updateBadge } from './badge.js';
import { handleGmMessage } from './gm-bridge.js';
import { connect } from './ws-client.js';

/* -------------------------- message routers ------------------------------ */

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
  if (msg && msg.__ms_control) {
    handleControl(msg)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) => sendResponse({ ok: false, error: String(err && err.message || err) }));
    return true;
  }
});

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

/* -------------------------- badge tab listeners -------------------------- */

// Re-badge tabs as they navigate / become active.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'loading' || changeInfo.url) {
    updateTabBadge(tabId, changeInfo.url || tab.url);
  }
});
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try { const tab = await chrome.tabs.get(tabId); updateTabBadge(tabId, tab.url); } catch {}
});

/* The toolbar action shows popup.html (set in manifest); the popup lists the
 * scripts running on the current tab and links to the dashboard. */

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
