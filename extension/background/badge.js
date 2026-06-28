/* Per-tab toolbar badge: number of ENABLED scripts that run on that tab. */

import { state } from './store.js';
import { scriptsForUrl } from './matching.js';

export async function updateTabBadge(tabId, url) {
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
export async function updateAllBadges() {
  try {
    await chrome.action.setBadgeBackgroundColor({ color: state.connected ? '#3fb950' : '#888' });
    const tabs = await chrome.tabs.query({});
    await Promise.all(tabs.map((t) => updateTabBadge(t.id, t.url)));
  } catch { /* ignore */ }
}

// Kept for older call-sites: now just refreshes colour + all tab badges.
export async function updateBadge() {
  await updateAllBadges();
}
