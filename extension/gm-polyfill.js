/* ==========================================================================
 * SayScript — GM / Tampermonkey compatibility polyfill.
 *
 * This file is injected (as code) at the TOP of every user script, inside the
 * USER_SCRIPT world. A tiny preamble injected by background.js defines, just
 * before this block:
 *
 *     const __MS_SCRIPT_ID__     = "<filename>";
 *     const __MS_INITIAL_VALUES__ = { ...persisted GM values... };
 *     const __MS_SCRIPT_INFO__    = { name, version, namespace, ... };
 *
 * The USER_SCRIPT world is CSP-exempt and — because background.js calls
 * chrome.userScripts.configureWorld({ messaging: true }) — `chrome.runtime`
 * is available here for talking to the service worker (which performs the
 * actual fetch() so we bypass page CORS).
 * ======================================================================== */
(function () {
  'use strict';

  const SCRIPT_ID = (typeof __MS_SCRIPT_ID__ !== 'undefined') ? __MS_SCRIPT_ID__ : 'unknown';
  const INFO      = (typeof __MS_SCRIPT_INFO__ !== 'undefined') ? __MS_SCRIPT_INFO__ : {};

  // --- synchronous value cache, seeded with the values background embedded ---
  const store = Object.assign(
    Object.create(null),
    (typeof __MS_INITIAL_VALUES__ !== 'undefined') ? __MS_INITIAL_VALUES__ : {}
  );

  /** Round-trip a message to the background service worker. */
  function call(type, payload) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage({ __sayscript: true, type, scriptId: SCRIPT_ID, ...payload })
          .then((res) => {
            if (res && res.ok) resolve(res.data);
            else reject(new Error((res && res.error) || 'SayScript messaging failed'));
          })
          .catch(reject);
      } catch (e) {
        reject(e);
      }
    });
  }

  /* ----------------------------------------------------------------------
   * Storage:  GM_setValue / GM_getValue / GM_deleteValue / GM_listValues
   * Reads are synchronous (served from `store`); writes update the cache
   * immediately and persist to chrome.storage.local via background.
   * -------------------------------------------------------------------- */

  function GM_setValue(key, value) {
    store[key] = value;
    call('GM_setValue', { key, value }).catch((e) => console.warn('[SayScript] setValue', e));
  }

  function GM_getValue(key, defaultValue) {
    return (key in store) ? store[key] : defaultValue;
  }

  function GM_deleteValue(key) {
    delete store[key];
    call('GM_deleteValue', { key }).catch((e) => console.warn('[SayScript] deleteValue', e));
  }

  function GM_listValues() {
    return Object.keys(store);
  }

  /* ----------------------------------------------------------------------
   * Networking:  GM_xmlhttpRequest — routed through background fetch().
   * Because background.js holds <all_urls> host permission, the request is
   * not subject to the page's CORS policy.
   * -------------------------------------------------------------------- */

  function GM_xmlhttpRequest(details) {
    details = details || {};
    const control = { abort() { aborted = true; } };
    let aborted = false;

    const responseType = (details.responseType || '').toLowerCase();

    call('GM_xmlhttpRequest', {
      details: {
        method: (details.method || 'GET').toUpperCase(),
        url: details.url,
        headers: details.headers || {},
        data: details.data ?? null,
        responseType,
        timeout: details.timeout || 0,
        binary: details.binary || false,
        anonymous: details.anonymous,
        withCredentials: details.withCredentials,
      },
    }).then((res) => {
      if (aborted) return;

      // Reconstruct the requested response body type on the page side.
      let response = res.body;
      if (responseType === 'arraybuffer' || responseType === 'blob') {
        const bin = atob(res.bodyBase64 || '');
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        response = (responseType === 'blob')
          ? new Blob([bytes], { type: res.contentType || '' })
          : bytes.buffer;
      } else if (responseType === 'json') {
        try { response = JSON.parse(res.body); } catch { response = null; }
      }

      const ctx = {
        readyState: 4,
        status: res.status,
        statusText: res.statusText,
        responseHeaders: res.headers,
        responseText: (responseType === 'arraybuffer' || responseType === 'blob') ? '' : (res.body || ''),
        response,
        finalUrl: res.finalUrl,
        context: details.context,
      };

      try {
        if (res.status >= 200 && res.status < 400) {
          if (typeof details.onload === 'function') details.onload(ctx);
        } else if (typeof details.onerror === 'function') {
          details.onerror(ctx);
        } else if (typeof details.onload === 'function') {
          details.onload(ctx);
        }
      } finally {
        if (typeof details.onloadend === 'function') details.onloadend(ctx);
      }
    }).catch((err) => {
      if (aborted) return;
      const ctx = { readyState: 4, status: 0, statusText: '', error: String(err && err.message || err), context: details.context };
      if (typeof details.onerror === 'function') details.onerror(ctx);
      if (typeof details.onloadend === 'function') details.onloadend(ctx);
    });

    return control;
  }

  /* ----------------------------------------------------------------------
   * Misc GM_* helpers
   * -------------------------------------------------------------------- */

  function GM_log(...args) { console.log('[' + (INFO.name || SCRIPT_ID) + ']', ...args); }

  function GM_addStyle(css) {
    const style = document.createElement('style');
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
    return style;
  }

  function GM_openInTab(url, options) {
    const active = (options === true) ? false : (options && options.active !== false);
    return window.open(url, '_blank', active ? '' : 'noopener');
  }

  function GM_setClipboard(text) {
    try {
      navigator.clipboard.writeText(String(text));
    } catch {
      const ta = document.createElement('textarea');
      ta.value = String(text);
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
  }

  function GM_registerMenuCommand(name, fn) {
    // No browser action menu in this dev build; expose them for discoverability.
    (window.__MS_MENU__ = window.__MS_MENU__ || []).push({ name, fn });
    return name;
  }
  function GM_unregisterMenuCommand() { /* no-op */ }
  function GM_notification(opts) {
    const text = (typeof opts === 'string') ? opts : (opts && opts.text) || '';
    GM_log('notification:', text);
  }

  const GM_info = {
    script: {
      name: INFO.name || SCRIPT_ID,
      namespace: INFO.namespace || '',
      version: INFO.version || '',
      description: INFO.description || '',
    },
    scriptHandler: 'SayScript',
    version: '1.0.0',
    scriptMetaStr: INFO.metaStr || '',
  };

  /* ----------------------------------------------------------------------
   * Promise-based GM.* namespace (modern API)
   * -------------------------------------------------------------------- */

  const GM = {
    info: GM_info,
    setValue: (k, v) => { GM_setValue(k, v); return call('GM_setValue', { key: k, value: v }); },
    getValue: (k, d) => Promise.resolve(GM_getValue(k, d)),
    deleteValue: (k) => { GM_deleteValue(k); return Promise.resolve(); },
    listValues: () => Promise.resolve(GM_listValues()),
    xmlHttpRequest: GM_xmlhttpRequest,
    addStyle: (css) => Promise.resolve(GM_addStyle(css)),
    openInTab: GM_openInTab,
    setClipboard: (t) => Promise.resolve(GM_setClipboard(t)),
    notification: GM_notification,
    registerMenuCommand: GM_registerMenuCommand,
    log: GM_log,
  };

  /* ----------------------------------------------------------------------
   * Expose everything on the userscript-world global.
   * -------------------------------------------------------------------- */

  const g = (typeof globalThis !== 'undefined') ? globalThis : window;

  g.GM                     = GM;
  g.GM_setValue            = GM_setValue;
  g.GM_getValue            = GM_getValue;
  g.GM_deleteValue         = GM_deleteValue;
  g.GM_listValues          = GM_listValues;
  g.GM_xmlhttpRequest      = GM_xmlhttpRequest;
  g.GM_xmlHttpRequest      = GM_xmlhttpRequest; // common misspelling alias
  g.GM_log                 = GM_log;
  g.GM_addStyle            = GM_addStyle;
  g.GM_openInTab           = GM_openInTab;
  g.GM_setClipboard        = GM_setClipboard;
  g.GM_registerMenuCommand = GM_registerMenuCommand;
  g.GM_unregisterMenuCommand = GM_unregisterMenuCommand;
  g.GM_notification        = GM_notification;
  g.GM_info                = GM_info;

  // unsafeWindow → the window object (USER_SCRIPT world shares the page DOM).
  if (typeof g.unsafeWindow === 'undefined') {
    g.unsafeWindow = window;
  }
})();
