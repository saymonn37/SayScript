/* SayScript toolbar popup — lists the scripts running on the current tab,
 * with on/off toggles, plus a link to the dashboard. */

const listEl = document.getElementById('list');
const emptyEl = document.getElementById('empty');
const connEl = document.getElementById('conn');

document.getElementById('dash-btn').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

/** Open the dashboard and jump straight into editing `filename`. The options
 *  page reads `ms_open_script` on load (and via storage.onChanged if already
 *  open) and opens that script in the editor. */
async function openInDashboard(filename) {
  try { await chrome.storage.local.set({ ms_open_script: filename }); } catch { /* ignore */ }
  chrome.runtime.openOptionsPage();
  window.close();
}

/* ----- shared icon cache (same `ms_icons` store the dashboard populates) ----- */
const iconCache = new Map();
const iconInflight = new Map();
let iconPersistTimer = null;

async function loadIconCache() {
  try {
    const d = await chrome.storage.local.get('ms_icons');
    for (const [k, v] of Object.entries(d.ms_icons || {})) iconCache.set(k, v);
  } catch { /* ignore */ }
}
function scheduleIconPersist() {
  clearTimeout(iconPersistTimer);
  iconPersistTimer = setTimeout(() => {
    const obj = {}; for (const [k, v] of iconCache) obj[k] = v;
    chrome.storage.local.set({ ms_icons: obj }).catch(() => {});
  }, 800);
}
function blobToDataURL(blob) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(blob); });
}
function resolveIcon(url) {
  if (!url || !/^https?:|^data:/.test(url)) return Promise.resolve(null);
  if (url.startsWith('data:')) return Promise.resolve(url);
  if (iconCache.has(url)) return Promise.resolve(iconCache.get(url) || null);
  if (iconInflight.has(url)) return iconInflight.get(url);
  const p = (async () => {
    try {
      const resp = await fetch(url, { credentials: 'omit' });
      if (!resp.ok) throw 0;
      const blob = await resp.blob();
      if (!blob.size || blob.size > 512 * 1024) throw 0;
      if (blob.type && !blob.type.startsWith('image/')) throw 0;
      const dataUrl = await blobToDataURL(blob);
      iconCache.set(url, dataUrl); scheduleIconPersist(); return dataUrl;
    } catch { iconCache.set(url, ''); scheduleIconPersist(); return null; }
    finally { iconInflight.delete(url); }
  })();
  iconInflight.set(url, p);
  return p;
}
function applyIcon(span, url) {
  span.textContent = '📜';
  resolveIcon(url).then((dataUrl) => {
    if (!dataUrl || !span.isConnected) return;
    span.textContent = '';
    const img = document.createElement('img');
    img.src = dataUrl; img.alt = '';
    span.appendChild(img);
  });
}

async function init() {
  await loadIconCache();
  let tab;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch { /* ignore */ }

  const url = tab && tab.url || '';

  let data;
  try {
    const res = await chrome.runtime.sendMessage({ __ms_control: true, action: 'get_active_scripts', url });
    if (res && res.ok) data = res.data;
  } catch { /* background asleep */ }

  const connected = data ? data.connected : false;
  connEl.classList.toggle('conn--on', connected);
  connEl.classList.toggle('conn--off', !connected);

  const scripts = (data && data.scripts) || [];
  render(scripts);
}

function render(scripts) {
  listEl.innerHTML = '';
  if (!scripts.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No scripts run on this page.';
    listEl.appendChild(li);
    return;
  }

  for (const s of scripts) {
    const li = document.createElement('li');
    li.className = 'item' + (s.enabled ? '' : ' disabled');

    const ic = document.createElement('span');
    ic.className = 'ic';
    applyIcon(ic, s.icon);

    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.title = 'Edit “' + s.name + '” in the dashboard';
    const t = document.createElement('div'); t.className = 't'; t.textContent = s.name;
    const v = document.createElement('div'); v.className = 'v'; v.textContent = s.version ? 'v' + s.version : '';
    nm.append(t, v);
    // Clicking the name jumps straight into editing this script.
    nm.addEventListener('click', () => openInDashboard(s.filename));

    const tg = document.createElement('span');
    tg.className = 'tg' + (s.enabled ? ' on' : '');
    tg.title = s.enabled ? 'Enabled — click to disable' : 'Disabled — click to enable';
    tg.addEventListener('click', async () => {
      const next = !li.classList.contains('disabled') ? false : true;
      // next === desired enabled state
      tg.classList.toggle('on', next);
      li.classList.toggle('disabled', !next);
      try {
        await chrome.runtime.sendMessage({ __ms_control: true, action: 'set_enabled', filename: s.filename, value: next });
      } catch { /* ignore */ }
    });

    li.append(ic, nm, tg);
    listEl.appendChild(li);
  }
}

init();
