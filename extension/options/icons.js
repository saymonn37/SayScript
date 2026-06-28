/* Icon cache for the dashboard. Each @icon is fetched once, converted to a
 * data: URL and stored in chrome.storage.local under `ms_icons` (permanent;
 * re-fetched only when a script is saved). Loaded as a classic script BEFORE
 * options/dashboard.js, sharing its global scope.
 * Exposes: loadIconCache(), resolveIcon(), invalidateIcon(), applyListIcon(). */

const iconCache = new Map();      // url -> dataURL ('' = known-bad, skip refetch)
const iconInflight = new Map();   // url -> Promise (de-dupe concurrent fetches)
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
    const obj = {};
    for (const [k, v] of iconCache) obj[k] = v;
    chrome.storage.local.set({ ms_icons: obj }).catch(() => {});
  }, 800);
}

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

/** Resolve an @icon URL to a cached data: URL (or null if unavailable). */
function resolveIcon(url) {
  if (!url || !/^https?:|^data:/.test(url)) return Promise.resolve(null);
  if (url.startsWith('data:')) return Promise.resolve(url);
  if (iconCache.has(url)) return Promise.resolve(iconCache.get(url) || null);
  if (iconInflight.has(url)) return iconInflight.get(url);

  const p = (async () => {
    try {
      const resp = await fetch(url, { credentials: 'omit' });
      if (!resp.ok) throw new Error('status ' + resp.status);
      const blob = await resp.blob();
      if (!blob.size || blob.size > 2 * 1024 * 1024) throw new Error('bad size');
      if (blob.type && !blob.type.startsWith('image/')) throw new Error('not an image');
      const dataUrl = await blobToDataURL(blob);
      iconCache.set(url, dataUrl);
      scheduleIconPersist();
      return dataUrl;
    } catch {
      iconCache.set(url, '');           // negative cache — don't keep retrying
      scheduleIconPersist();
      return null;
    } finally {
      iconInflight.delete(url);
    }
  })();
  iconInflight.set(url, p);
  return p;
}

/** Force a fresh fetch of an icon next time it's needed (called on save). */
function invalidateIcon(url) {
  if (!url) return;
  iconCache.delete(url);
  iconInflight.delete(url);
  scheduleIconPersist();
}

/** Show a cached icon inside a `.si-icon` span (📜 placeholder until ready). */
function applyListIcon(span, url) {
  span.textContent = '📜';
  resolveIcon(url).then((dataUrl) => {
    if (!dataUrl || !span.isConnected) return;
    span.textContent = '';
    const img = document.createElement('img');
    img.src = dataUrl; img.alt = '';
    img.style.cssText = 'width:18px;height:18px;object-fit:contain;border-radius:4px';
    span.appendChild(img);
  });
}
