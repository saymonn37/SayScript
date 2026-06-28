/* chrome.userScripts registration — turns the in-memory script set into live,
 * CSP-exempt injections, each wrapped in its own IIFE with the GM polyfill
 * prepended. All (re)registration is serialized on one chain so concurrent
 * callers (boot + WS all_scripts) can't double-register the same id. */

import { state, isEnabled, getValuesFor } from './store.js';
import { updateBadge } from './badge.js';

let polyfillSource = '';         // gm-polyfill.js text, loaded once

async function loadPolyfill() {
  if (polyfillSource) return polyfillSource;
  const res = await fetch(chrome.runtime.getURL('gm-polyfill.js'));
  polyfillSource = await res.text();
  return polyfillSource;
}

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

// Serialize all (re)registration so concurrent callers can't both read an empty
// list and then register the same ID twice.
let syncChain = Promise.resolve();

export function syncRegistrations() {
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
export function applyOneRegistration(filename, enabled) {
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
