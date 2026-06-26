// ==UserScript==
// @name         SayScript Example
// @namespace    sayscript
// @version      1.0.0
// @description  Demo script — GM storage + CORS-free GM_xmlhttpRequest. Edit it in the dashboard or on disk; both sync live.
// @match        *://*/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=example.com
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @grant        GM_log
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // Persisted across reloads via chrome.storage.local (per script).
  const visits = (GM_getValue('visits', 0) || 0) + 1;
  GM_setValue('visits', visits);
  GM_log('Visit #' + visits + ' to ' + location.host);

  // CORS-free request routed through the background service worker's fetch().
  GM_xmlhttpRequest({
    method: 'GET',
    url: 'https://httpbin.org/get',
    onload: (res) => GM_log('httpbin status', res.status),
    onerror: () => GM_log('request failed'),
  });

  console.log('[SayScript] example userscript running on', location.href);
})();
