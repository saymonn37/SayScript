/* The GM bridge: services GM_* messages from the USER_SCRIPT world.
 *
 * GM_xmlhttpRequest is routed through the background fetch() so it bypasses the
 * page's CORS (the extension holds <all_urls>). GM value ops hit chrome.storage.
 */

import { setValueFor, deleteValueFor, getValuesFor } from './store.js';

export async function handleGmMessage(msg) {
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

/* ----- background fetch (CORS bypass) ----- */

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
