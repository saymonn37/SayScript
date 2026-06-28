/* Self-contained JS syntax highlighter for the dashboard editor (no external
 * libs — MV3 CSP forbids remote scripts). Loaded as a classic script BEFORE
 * options/dashboard.js, sharing its global scope.
 * Exposes: highlight(), escapeHtml(), KEYWORDS/LITERALS/GM_IDENT, regexAllowed(), skipSpace(). */

const KEYWORDS = new Set(('break case catch class const continue debugger default delete do else ' +
  'export extends finally for function if import in instanceof let new return super switch this throw ' +
  'try typeof var void while with yield async await of static get set').split(' '));
const LITERALS = new Set('true false null undefined NaN Infinity'.split(' '));
const GM_IDENT = /^(GM_\w+|GM|unsafeWindow)$/;

function escapeHtml(s) {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

/**
 * Tokenize JavaScript into highlighted HTML. Handles line/block comments,
 * single/double/template strings, regex literals (heuristic), numbers,
 * identifiers/keywords, and the UserScript metadata block.
 */
function highlight(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let prevSignificant = ''; // last non-space token text, to disambiguate regex vs divide

  // metadata block gets a flat highlight first if present at the very top
  while (i < n) {
    const c = src[i];

    // line comment
    if (c === '/' && src[i + 1] === '/') {
      let j = src.indexOf('\n', i); if (j === -1) j = n;
      const seg = src.slice(i, j);
      const cls = /@\w/.test(seg) ? 'tok-meta' : 'tok-comment';
      out += `<span class="${cls}">${escapeHtml(seg)}</span>`;
      i = j; continue;
    }
    // block comment
    if (c === '/' && src[i + 1] === '*') {
      let j = src.indexOf('*/', i + 2); j = (j === -1) ? n : j + 2;
      out += `<span class="tok-comment">${escapeHtml(src.slice(i, j))}</span>`;
      i = j; continue;
    }
    // strings
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n) { if (src[j] === '\\') j += 2; else if (src[j] === c) { j++; break; } else j++; }
      out += `<span class="tok-string">${escapeHtml(src.slice(i, j))}</span>`;
      i = j; prevSignificant = 'str'; continue;
    }
    // template literal
    if (c === '`') {
      let j = i + 1;
      while (j < n) { if (src[j] === '\\') j += 2; else if (src[j] === '`') { j++; break; } else j++; }
      out += `<span class="tok-template">${escapeHtml(src.slice(i, j))}</span>`;
      i = j; prevSignificant = 'str'; continue;
    }
    // regex literal (heuristic: only when a value cannot precede)
    if (c === '/' && regexAllowed(prevSignificant)) {
      let j = i + 1, inClass = false, ok = false;
      while (j < n) {
        const d = src[j];
        if (d === '\\') { j += 2; continue; }
        if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) { j++; ok = true; break; }
        else if (d === '\n') break;
        j++;
      }
      if (ok) {
        while (j < n && /[a-z]/i.test(src[j])) j++; // flags
        out += `<span class="tok-regex">${escapeHtml(src.slice(i, j))}</span>`;
        i = j; prevSignificant = 'regex'; continue;
      }
    }
    // numbers
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] || ''))) {
      let j = i;
      while (j < n && /[0-9a-fxob_.eE+\-]/.test(src[j])) {
        if ((src[j] === '+' || src[j] === '-') && !/[eE]/.test(src[j - 1])) break;
        j++;
      }
      out += `<span class="tok-number">${escapeHtml(src.slice(i, j))}</span>`;
      i = j; prevSignificant = 'num'; continue;
    }
    // identifiers / keywords
    if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$]/.test(src[j])) j++;
      const word = src.slice(i, j);
      let cls = '';
      if (KEYWORDS.has(word)) cls = 'tok-keyword';
      else if (LITERALS.has(word)) cls = 'tok-bool';
      else if (GM_IDENT.test(word)) cls = 'tok-gm';
      else if (src[j] === '(' || (skipSpace(src, j) === '(')) cls = 'tok-func';
      out += cls ? `<span class="${cls}">${escapeHtml(word)}</span>` : escapeHtml(word);
      i = j; prevSignificant = word; continue;
    }
    // whitespace
    if (/\s/.test(c)) { out += c; i++; continue; }
    // punctuation
    out += `<span class="tok-punct">${escapeHtml(c)}</span>`;
    i++;
    if (!/\s/.test(c)) prevSignificant = c;
  }
  return out;
}

function regexAllowed(prev) {
  if (prev === '' ) return true;
  if (prev === 'str' || prev === 'num' || prev === 'regex') return false;
  if (/^[A-Za-z0-9_$]+$/.test(prev)) {
    return KEYWORDS.has(prev); // after `return`, `typeof`, etc. a regex is fine
  }
  return !(prev === ')' || prev === ']'); // after these a `/` is division
}
function skipSpace(src, j) { while (j < src.length && /\s/.test(src[j])) j++; return src[j]; }
