/* In-memory state + chrome.storage.local persistence (survives SW teardown),
 * plus per-script GM value storage.
 *
 * Storage keys (DO NOT rename — renaming wipes user state):
 *   ms_scripts, ms_enabled, ms_values:<filename>
 */

export const state = {
  scripts: new Map(),     // filename -> script record from the server
  enabled: {},            // filename -> bool (default true), persisted
  connected: false,
};

export function isEnabled(filename) {
  return state.enabled[filename] !== false; // default ON
}

export async function loadState() {
  const data = await chrome.storage.local.get(['ms_scripts', 'ms_enabled']);
  state.enabled = data.ms_enabled || {};
  if (Array.isArray(data.ms_scripts)) {
    for (const s of data.ms_scripts) state.scripts.set(s.filename, s);
  }
}

export async function persistScripts() {
  await chrome.storage.local.set({ ms_scripts: [...state.scripts.values()] });
}

export async function persistEnabled() {
  await chrome.storage.local.set({ ms_enabled: state.enabled });
}

/* GM values are stored per script under `ms_values:<filename>` and embedded
 * (synchronously) into the injected preamble so GM_getValue is sync. */

export async function getValuesFor(filename) {
  const key = 'ms_values:' + filename;
  const data = await chrome.storage.local.get(key);
  return data[key] || {};
}

export async function setValueFor(filename, k, v) {
  const values = await getValuesFor(filename);
  values[k] = v;
  await chrome.storage.local.set({ ['ms_values:' + filename]: values });
}

export async function deleteValueFor(filename, k) {
  const values = await getValuesFor(filename);
  delete values[k];
  await chrome.storage.local.set({ ['ms_values:' + filename]: values });
}
