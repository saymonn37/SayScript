/* Resilient WebSocket client to the PHP server (auto-reconnect + keepalive).
 * Mirrors the server's script set into chrome.storage + re-registers on change.
 * Bursts of script_changed (e.g. importing hundreds) are debounced into one
 * persist + re-registration to avoid O(n²) churn. */

import { state, persistScripts } from './store.js';
import { syncRegistrations } from './registration.js';
import { updateBadge } from './badge.js';

const WS_URL = 'ws://localhost:8165';

let socket = null;
let reconnectTimer = null;
let reconnectDelay = 1000;       // backoff, capped
let keepAliveTimer = null;
let changeDebounce = null;

export function connect() {
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
// script_changed events) into a SINGLE persist + re-registration.
function scheduleApplyChanges(delayMs) {
  clearTimeout(changeDebounce);
  changeDebounce = setTimeout(() => {
    changeDebounce = null;
    persistScripts().catch(() => {});
    syncRegistrations();
  }, delayMs);
}

function handleServerMessage(msg) {
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
