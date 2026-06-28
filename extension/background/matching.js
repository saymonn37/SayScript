/* URL matching — decides which scripts apply to a given tab (for the per-tab
 * badge count and the toolbar popup). Mirrors Tampermonkey's OR semantics:
 * a script applies if any @match OR any @include matches, minus @exclude. */

import { state, isEnabled } from './store.js';

function globToRegexSource(glob) {
  return glob.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
}

function matchPatternMatches(pattern, u) {
  if (pattern === '<all_urls>') return /^(https?|file|ftp|wss?):$/.test(u.protocol);
  const m = /^([^:]+):\/\/([^/]*)(\/.*)?$/.exec(pattern);
  if (!m) return false;
  const scheme = m[1];
  const host = m[2];
  const path = m[3] || '/*';
  const proto = u.protocol.replace(':', '');
  if (scheme === '*') { if (proto !== 'http' && proto !== 'https') return false; }
  else if (scheme !== proto) return false;

  if (host && host !== '*') {
    // Chrome semantics: "*.example.com" matches example.com AND any subdomain.
    // Tampermonkey also allows ports in the host part (localhost:8000, jj.local:*).
    const hostSrc = host.startsWith('*.')
      ? '(?:.*\\.)?' + host.slice(2).replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      : globToRegexSource(host);
    const hostRx = new RegExp('^' + hostSrc + '$', 'i');
    if (!hostRx.test(u.host) && !hostRx.test(u.hostname)) return false;
  }
  const target = u.pathname + (u.search || '');
  const pathRx = new RegExp('^' + globToRegexSource(path) + '$');
  if (!pathRx.test(target) && !pathRx.test(u.pathname)) return false;
  return true;
}

function includeMatches(inc, url) {
  if (inc === '*' || inc === '*://*/*') return true;
  if (inc.length > 2 && inc[0] === '/' && inc.endsWith('/')) {
    try { return new RegExp(inc.slice(1, -1)).test(url); } catch { return false; }
  }
  let g = inc;
  if (!/:\/\//.test(g) && g[0] !== '*') g = '*' + g + '*';
  try { return new RegExp('^' + globToRegexSource(g) + '$', 'i').test(url); } catch { return false; }
}

/** Does this script apply to `url`? */
function scriptMatchesUrl(script, url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (!/^(https?|file|ftp|wss?):$/.test(u.protocol)) return false;

  const excludes = script.excludes || [];
  if (excludes.some((e) => includeMatches(e, url) || matchPatternMatches(e, u))) return false;

  const matches = script.matches || [];
  const includes = script.includes || [];
  if (matches.length === 0 && includes.length === 0) return false;
  if (matches.some((m) => matchPatternMatches(m, u))) return true;
  if (includes.some((i) => includeMatches(i, url))) return true;
  return false;
}

/** Scripts that apply to `url`, with their enabled flag. */
export function scriptsForUrl(url) {
  const out = [];
  for (const s of state.scripts.values()) {
    if (scriptMatchesUrl(s, url)) {
      out.push({
        filename: s.filename,
        name: s.name || s.filename,
        icon: s.icon || null,
        version: s.version || '',
        enabled: isEnabled(s.filename),
      });
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  return out;
}
