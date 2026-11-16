// A fast, dependency-free Markdown to HTML renderer.
//
// Covers CommonMark 0.31.2 plus the GFM 0.29 extensions (tables, task list
// items, strikethrough, extended autolinks), reproducing the output of
// marked 18.1.3 under its default options, byte for byte. The implementation
// is line-based for blocks and node-based for inline content; every rule
// below was derived from the specs and from marked's observable behaviour
// on the practice set.

// ------------------------------------------------------------ char classes

function isAsciiPunct(c) {
  return (c >= 33 && c <= 47) || (c >= 58 && c <= 64) ||
    (c >= 91 && c <= 96) || (c >= 123 && c <= 126);
}
function isDigit(c) { return c >= 48 && c <= 57; }
function isAlpha(c) { return (c >= 65 && c <= 90) || (c >= 97 && c <= 122); }
function isAlnum(c) { return isDigit(c) || isAlpha(c); }
function isSpaceOrTab(c) { return c === 32 || c === 9; }

// Length, including the trailing ';', of the entity-shaped run starting at
// s[i] (which holds '&'), or 0 when there is none. Named shapes are kept
// verbatim and are never checked against an entity table; numeric shapes
// count only while their value stays within the Unicode range.
function entityLen(s, i) {
  const n = s.length;
  let j = i + 1;
  if (j < n && s.charCodeAt(j) === 35) {
    j++;
    let hex = false;
    if (j < n && (s.charCodeAt(j) === 120 || s.charCodeAt(j) === 88)) { hex = true; j++; }
    const digitsStart = j;
    let value = 0;
    while (j < n) {
      const c = s.charCodeAt(j);
      let d = -1;
      if (c >= 48 && c <= 57) d = c - 48;
      else if (hex && c >= 97 && c <= 102) d = c - 87;
      else if (hex && c >= 65 && c <= 70) d = c - 55;
      else break;
      value = value * (hex ? 16 : 10) + d;
      if (value > 0x10FFFF) return 0;
      j++;
    }
    if (j > digitsStart && j < n && s.charCodeAt(j) === 59) return j - i + 1;
    return 0;
  }
  const nameStart = j;
  while (j < n) {
    const c = s.charCodeAt(j);
    if (isAlnum(c) || c === 95) j++;
    else break;
  }
  if (j > nameStart && j < n && s.charCodeAt(j) === 59) return j - i + 1;
  return 0;
}

// Decode the numeric character reference starting at s[i] ('&').
// Yields [codePoint, length] or null. Zero and surrogate values become
// U+FFFD; values above 0x10FFFF are not references at all.
function decodeNumericRef(s, i) {
  const n = s.length;
  let j = i + 1;
  if (j >= n || s.charCodeAt(j) !== 35) return null;
  j++;
  let hex = false;
  if (j < n && (s.charCodeAt(j) === 120 || s.charCodeAt(j) === 88)) { hex = true; j++; }
  const digitsStart = j;
  let value = 0;
  while (j < n) {
    const c = s.charCodeAt(j);
    let d = -1;
    if (c >= 48 && c <= 57) d = c - 48;
    else if (hex && c >= 97 && c <= 102) d = c - 87;
    else if (hex && c >= 65 && c <= 70) d = c - 55;
    else break;
    value = value * (hex ? 16 : 10) + d;
    if (value > 0x10FFFF) return null;
    j++;
  }
  if (j === digitsStart || j >= n || s.charCodeAt(j) !== 59) return null;
  if (value === 0 || (value >= 0xD800 && value <= 0xDFFF)) value = 0xFFFD;
  return [value, j - i + 1];
}

// Escape text for HTML output. With encode=false, entity-shaped runs pass
// through untouched; with encode=true every '&' is escaped. The characters
// < > " ' are always escaped.
function escapeHtml(s, encode) {
  let out = null;
  let start = 0;
  const n = s.length;
  for (let i = 0; i < n; i++) {
    const c = s.charCodeAt(i);
    let rep = null;
    if (c === 38) {
      if (!encode) {
        const L = entityLen(s, i);
        if (L > 0) { i += L - 1; continue; }
      }
      rep = '&amp;';
    } else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    if (rep !== null) {
      if (out === null) out = [];
      if (start < i) out.push(s.slice(start, i));
      out.push(rep);
      start = i + 1;
    }
  }
  if (out === null) return s;
  if (start < n) out.push(s.slice(start));
  return out.join('');
}

// Clean a link destination: encodeURI, with '%' restored so that existing
// percent-escapes survive. Returns null for lone surrogates.
function cleanUrl(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch (e) {
    return null;
  }
}

// Resolve backslash escapes: a backslash before ASCII punctuation yields
// the punctuation; anything else stays literal.
function unescapeBackslashes(s) {
  if (s.indexOf('\\') === -1) return s;
  let out = '';
  for (let i = 0, n = s.length; i < n; i++) {
    const c = s.charCodeAt(i);
    if (c === 92 && i + 1 < n && isAsciiPunct(s.charCodeAt(i + 1))) { out += s[i + 1]; i++; }
    else out += s[i];
  }
  return out;
}

// Case-folding extras for reference-label normalization, beyond what
// String.prototype.toLowerCase already does.
const FOLD_MAP = {
  '\u00DF': 'ss', '\uFB00': 'ff', '\uFB01': 'fi', '\uFB02': 'fl',
  '\uFB03': 'ffi', '\uFB04': 'ffl', '\uFB05': 'st', '\uFB06': 'st',
  '\u00B5': '\u03BC', '\u03C2': '\u03C3',
  '\uFB13': '\u0574\u0576', '\uFB14': '\u0574\u0565', '\uFB15': '\u0574\u056B',
  '\uFB16': '\u057E\u0576', '\uFB17': '\u0574\u056D',
};

// Normalize a link reference label: collapse each whitespace run to a
// single space, trim the ends, fold case. Backslash escapes are deliberately
// left unresolved, so `\!` and `!` never match.
function normalizeLabel(raw) {
  let out = '';
  let pendingSpace = false;
  let started = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10 || c === 13) {
      if (started) pendingSpace = true;
    } else {
      if (pendingSpace) { out += ' '; pendingSpace = false; }
      out += raw[i];
      started = true;
    }
  }
  out = out.toLowerCase();
  if (/[^\x00-\x7F]/.test(out)) {
    out = out.replace(/[\u00DF\uFB00-\uFB06\u00B5\u03C2\uFB13-\uFB17]/g, (ch) => FOLD_MAP[ch]);
  }
  return out;
}

// ------------------------------------------------------------ line splitting

// Split the input into lines, normalizing CRLF and CR to LF. Each line
// records whether it was terminated by a line ending.
function splitLines(src) {
  src = src.replace(/\r\n?/g, '\n');
  if (src === '') return [];
  const parts = src.split('\n');
  const trailing = src.charCodeAt(src.length - 1) === 10;
  if (trailing) parts.pop();
  const lines = new Array(parts.length);
  for (let i = 0; i < parts.length; i++) {
    lines[i] = { text: parts[i], end: trailing || i < parts.length - 1 };
  }
  return lines;
}

// A cursor over one line, tracking the visual column and tabs that have
// been only partly consumed. quoteCol records the column of the innermost
// blockquote marker matched on this line (or -1), which anchors tab
// expansion inside fenced code.
class Cursor {
  constructor(text) {
    this.s = text;
    this.i = 0;
    this.col = 0;
    this.tab = 0;
    this.quoteCol = -1;
  }
  clone() {
    const c = new Cursor(this.s);
    c.i = this.i;
    c.col = this.col;
    c.tab = this.tab;
    c.quoteCol = this.quoteCol;
    return c;
  }
  code() {
    if (this.tab > 0) return 32;
    return this.i < this.s.length ? this.s.charCodeAt(this.i) : -1;
  }
  atEnd() { return this.tab === 0 && this.i >= this.s.length; }
  adv(n) {
    while (n > 0) {
      if (this.tab > 0) {
        const t = Math.min(n, this.tab);
        this.tab -= t;
        this.col += t;
        n -= t;
        if (this.tab === 0) this.i++;
        continue;
      }
      if (this.i >= this.s.length) { this.col += n; return; }
      const c = this.s.charCodeAt(this.i);
      if (c === 9) {
        const w = 4 - (this.col & 3);
        if (n >= w) { this.i++; this.col += w; n -= w; }
        else { this.tab = w - n; this.col += n; n = 0; }
      } else {
        this.i++;
        this.col++;
        n--;
      }
    }
  }
  skipWs(maxCols) {
    let n = 0;
    while (n < maxCols) {
      const c = this.code();
      if (c === 32 || c === 9) { this.adv(1); n++; }
      else break;
    }
    return n;
  }
  // Like skipWs, but a tab character met while stripping is consumed
  // whole, even if its width exceeds the remaining strip amount: a
  // fenced code line whose leading tab starts inside the stripped
  // indent loses the tab entirely (doc-17: indent 3, tab width 4).
  skipWsTabs(maxCols) {
    let n = 0;
    while (n < maxCols) {
      if (this.tab > 0) {
        const take = Math.min(this.tab, maxCols - n);
        this.tab -= take;
        this.col += take;
        n += take;
        if (this.tab === 0) this.i++;
        continue;
      }
      if (this.i >= this.s.length) break;
      const c = this.s.charCodeAt(this.i);
      if (c === 32) { this.i++; this.col++; n++; }
      else if (c === 9) {
        const w = 4 - (this.col & 3);
        this.i++; this.col += w; n += w;
      } else break;
    }
    return n;
  }
  blank() {
    for (let i = this.i; i < this.s.length; i++) {
      const c = this.s.charCodeAt(i);
      if (c !== 32 && c !== 9) return false;
    }
    return true;
  }
  rest() {
    // A partly consumed tab yields its remaining columns as spaces; the
    // tab character itself never reappears.
    if (this.tab > 0) return ' '.repeat(this.tab) + this.s.slice(this.i + 1);
    return this.s.slice(this.i);
  }
}

// The content of a code-block line starting at cursor c. A partly consumed
// tab expands to spaces. In fenced code, a whole leading tab expands to
// spaces up to the next tab stop measured from the innermost blockquote
// marker (or the line start when no quote matched); a tab at column 0
// stays a raw tab. In indented code a tab at the strip boundary stays raw.
function codeRest(c, isFence) {
  if (c.tab > 0) return c.rest();
  if (isFence && c.col > 0 && c.i < c.s.length && c.s.charCodeAt(c.i) === 9) {
    const e = c.quoteCol >= 0 ? c.col - c.quoteCol : c.col;
    if (e > 0) return ' '.repeat(4 - (e & 3)) + c.s.slice(c.i + 1);
  }
  return c.rest();
}

// ---------------------------------------------------------- block-start tests

// Thematic break: three or more of one marker char (*, -, _), with only
// spaces and tabs around them. The indent has already been skipped.
function isThematicBreak(rest) {
  const n = rest.length;
  if (n === 0) return false;
  const m = rest.charCodeAt(0);
  if (m !== 42 && m !== 45 && m !== 95) return false;
  let count = 0;
  for (let i = 0; i < n; i++) {
    const c = rest.charCodeAt(i);
    if (c === m) count++;
    else if (c !== 32 && c !== 9) return false;
  }
  return count >= 3;
}

// Setext underline: returns 1 for '=', 2 for '-', 0 otherwise. The run must
// be unbroken and followed only by trailing whitespace.
function setextLevel(rest) {
  const n = rest.length;
  if (n === 0) return 0;
  const m = rest.charCodeAt(0);
  if (m !== 61 && m !== 45) return 0;
  let i = 0;
  while (i < n && rest.charCodeAt(i) === m) i++;
  while (i < n && isSpaceOrTab(rest.charCodeAt(i))) i++;
  return i === n ? (m === 61 ? 1 : 2) : 0;
}

// ATX heading: yields {level, content} or null. The indent has been skipped.
function parseAtx(rest) {
  const n = rest.length;
  let i = 0;
  while (i < n && rest.charCodeAt(i) === 35) i++;
  if (i === 0 || i > 6) return null;
  if (i < n && !isSpaceOrTab(rest.charCodeAt(i))) return null;
  let j = i;
  while (j < n && isSpaceOrTab(rest.charCodeAt(j))) j++;
  let content = rest.slice(j);
  let e = content.length;
  while (e > 0 && isSpaceOrTab(content.charCodeAt(e - 1))) e--;
  content = content.slice(0, e);
  // Remove a closing sequence: trailing '#'s preceded by whitespace, or a
  // heading made of '#'s alone.
  let h = content.length;
  while (h > 0 && content.charCodeAt(h - 1) === 35) h--;
  if (h < content.length) {
    if (h === 0) content = '';
    else if (isSpaceOrTab(content.charCodeAt(h - 1))) {
      let k = h - 1;
      while (k > 0 && isSpaceOrTab(content.charCodeAt(k - 1))) k--;
      content = content.slice(0, k);
    }
  }
  return { level: i, content };
}

// Fenced code opener: yields {ch, len, info} or null. A backtick fence's
// info string may not itself contain a backtick.
function parseFence(rest) {
  const n = rest.length;
  if (n === 0) return null;
  const ch = rest.charCodeAt(0);
  if (ch !== 96 && ch !== 126) return null;
  let i = 0;
  while (i < n && rest.charCodeAt(i) === ch) i++;
  if (i < 3) return null;
  const info = rest.slice(i);
  if (ch === 96 && info.indexOf('`') !== -1) return null;
  return { ch, len: i, info };
}

// Fenced code closer: same fence char, at least as long, nothing but
// whitespace after it. The indent has been skipped.
function isClosingFence(rest, fcode) {
  const n = rest.length;
  let i = 0;
  while (i < n && rest.charCodeAt(i) === fcode.ch) i++;
  if (i < fcode.len) return false;
  while (i < n && isSpaceOrTab(rest.charCodeAt(i))) i++;
  return i === n;
}

// Tag names that start an HTML block of type 6.
const BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem meta nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul').split(' '));

// Scan a complete HTML tag at the start of s. Returns the index just past
// '>', or -1 when the text is not a complete tag. Handles open tags with
// attributes and closing tags; every attribute must be separated from the
// previous token by whitespace.
function scanHtmlTag(s) {
  const n = s.length;
  if (s.charCodeAt(0) !== 60) return -1;
  let i = 1;
  let closing = false;
  if (i < n && s.charCodeAt(i) === 47) { closing = true; i++; }
  if (i >= n || !isAlpha(s.charCodeAt(i))) return -1;
  while (i < n && (isAlnum(s.charCodeAt(i)) || s.charCodeAt(i) === 45)) i++;
  if (closing) {
    while (i < n && isSpaceOrTab(s.charCodeAt(i))) i++;
    if (i < n && s.charCodeAt(i) === 62) return i + 1;
    return -1;
  }
  let lastEnd = i;
  while (true) {
    while (i < n && isSpaceOrTab(s.charCodeAt(i))) i++;
    if (i >= n) return -1;
    const c = s.charCodeAt(i);
    if (c === 62) return i + 1;
    if (c === 47) {
      i++;
      if (i < n && s.charCodeAt(i) === 62) return i + 1;
      return -1;
    }
    if (i <= lastEnd) return -1;
    if (!(isAlpha(c) || c === 95 || c === 58)) return -1;
    i++;
    while (i < n) {
      const d = s.charCodeAt(i);
      if (isAlnum(d) || d === 95 || d === 58 || d === 45 || d === 46) i++;
      else break;
    }
    lastEnd = i;
    while (i < n && isSpaceOrTab(s.charCodeAt(i))) i++;
    if (i < n && s.charCodeAt(i) === 61) {
      i++;
      while (i < n && isSpaceOrTab(s.charCodeAt(i))) i++;
      if (i >= n) return -1;
      const q = s.charCodeAt(i);
      if (q === 34 || q === 39) {
        i++;
        while (i < n && s.charCodeAt(i) !== q) i++;
        if (i >= n) return -1;
        i++;
      } else {
        let seen = false;
        while (i < n) {
          const d = s.charCodeAt(i);
          if (isSpaceOrTab(d) || d === 34 || d === 39 || d === 61 || d === 60 || d === 62 || d === 96) break;
          seen = true;
          i++;
        }
        if (!seen) return -1;
      }
      lastEnd = i;
    }
  }
}

// HTML block start type (1-7) for a line whose indent was skipped, or 0.
// Type 7 additionally requires the tag to stand alone on the line.
function htmlBlockType(rest) {
  const n = rest.length;
  if (n === 0 || rest.charCodeAt(0) !== 60) return 0;
  const lower = rest.slice(0, 12).toLowerCase();
  for (const name of ['script', 'pre', 'style', 'textarea']) {
    if (lower.startsWith(name, 1)) {
      const ai = 1 + name.length;
      const after = ai < n ? rest.charCodeAt(ai) : -1;
      if (after === -1 || isSpaceOrTab(after) || after === 62) return 1;
    }
  }
  if (rest.startsWith('<!--')) return 2;
  if (rest.startsWith('<?')) return 3;
  if (n >= 3 && rest.charCodeAt(1) === 33 && isAlpha(rest.charCodeAt(2))) return 4;
  if (rest.startsWith('<![CDATA[')) return 5;
  let i = 1;
  let closing = false;
  if (i < n && rest.charCodeAt(i) === 47) { closing = true; i++; }
  const nameStart = i;
  while (i < n && (isAlnum(rest.charCodeAt(i)) || rest.charCodeAt(i) === 45)) i++;
  if (i > nameStart) {
    const name = rest.slice(nameStart, i).toLowerCase();
    const after = i < n ? rest.charCodeAt(i) : -1;
    if (BLOCK_TAGS.has(name) && (after === -1 || isSpaceOrTab(after) || after === 62 || after === 47)) return 6;
    if (name !== 'pre' && name !== 'script' && name !== 'style' && name !== 'textarea') {
      const end = scanHtmlTag(rest);
      if (end !== -1) {
        let k = end;
        while (k < n && isSpaceOrTab(rest.charCodeAt(k))) k++;
        if (k === n) return 7;
      }
    }
  }
  return 0;
}

// Whether the line after an end-hit HTML block absorbs its trailing
// newline: at top level only a truly empty line does (a lone tab does
// not); inside quotes, a line that matches all enclosing quotes and
// has only spaces left does.
function htmlNextAbsorbs(text, qdepth) {
  if (qdepth === 0) return text.length === 0;
  let i = 0;
  for (let q = 0; q < qdepth; q++) {
    let sp = 0;
    while (sp < 3 && i < text.length && text.charCodeAt(i) === 32) { i++; sp++; }
    if (i >= text.length || text.charCodeAt(i) !== 62) return false;
    i++;
    if (i < text.length && text.charCodeAt(i) === 32) i++;
  }
  for (; i < text.length; i++) if (text.charCodeAt(i) !== 32) return false;
  return true;
}

// Whether this line contains the end marker for an HTML block of type 1-5.
function htmlEndHit(htype, line) {
  const low = line.toLowerCase();
  switch (htype) {
    case 1:
      return low.includes('</script') || low.includes('</pre') ||
        low.includes('</style') || low.includes('</textarea');
    case 2: return line.includes('-->');
    case 3: return line.includes('?>');
    case 4: return line.includes('>');
    case 5: return line.includes(']]>');
  }
  return false;
}

// Parse a list marker. `rest` is the line remainder with indent skipped and
// `cur` the cursor at the same position; the marker and its following
// spaces are consumed from cur, leaving it at the content position.
// Returns marker info or null.
function parseListMarker(cur, rest) {
  const n = rest.length;
  if (n === 0) return null;
  const c0 = rest.charCodeAt(0);
  let ordered = false, delim = 0, bullet = 0, start = 0, markerLen = 0;
  if (c0 === 45 || c0 === 43 || c0 === 42) {
    bullet = c0;
    markerLen = 1;
  } else if (isDigit(c0)) {
    let i = 0;
    while (i < n && isDigit(rest.charCodeAt(i))) i++;
    if (i > 9) return null;
    if (i < n && (rest.charCodeAt(i) === 46 || rest.charCodeAt(i) === 41)) {
      const v = parseInt(rest.slice(0, i), 10);
      if (v > 999999999) return null;
      ordered = true;
      delim = rest.charCodeAt(i);
      start = v;
      markerLen = i + 1;
    } else return null;
  } else return null;
  if (markerLen < n && !isSpaceOrTab(rest.charCodeAt(markerLen))) return null;
  cur.adv(markerLen);
  const markerEndCol = cur.col;
  const probe = cur.clone();
  const ws = probe.skipWs(100);
  const empty = probe.atEnd();
  let contentIndent;
  if (empty) {
    contentIndent = markerEndCol + 1;
    cur.adv(ws);
  } else if (ws >= 5) {
    contentIndent = markerEndCol + 1;
    cur.adv(1);
  } else {
    contentIndent = markerEndCol + ws;
    cur.adv(ws);
  }
  return { ordered, delim, bullet, start, contentIndent, empty };
}

// ------------------------------------------------------------ table helpers

// Split a table row into cells. Outer leading/trailing pipes are removed,
// pipes inside code spans do not split, and a pipe preceded by an odd
// number of backslashes is a literal pipe (the escape is resolved after
// splitting, before trimming).
function splitTableRow(line) {
  let s = line;
  let a = 0, b = s.length;
  while (a < b && isSpaceOrTab(s.charCodeAt(a))) a++;
  while (b > a && isSpaceOrTab(s.charCodeAt(b - 1))) b--;
  s = s.slice(a, b);
  if (s.charCodeAt(0) === 124) s = s.slice(1);
  if (s.length > 0 && s.charCodeAt(s.length - 1) === 124) s = s.slice(0, -1);
  const cells = [];
  let start = 0;
  const n = s.length;
  let i = 0;
  let poisoned = false;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 96 && !poisoned) {
      let j = i;
      while (j < n && s.charCodeAt(j) === 96) j++;
      const run = j - i;
      let k = j, found = -1;
      while (k < n) {
        if (s.charCodeAt(k) === 96) {
          let m = k;
          while (m < n && s.charCodeAt(m) === 96) m++;
          if (m - k === run) { found = m; break; }
          k = m;
        } else k++;
      }
      if (found !== -1) { i = found; continue; }
      // An unclosed backtick run poisons the rest of the row: no later
      // backtick run starts a code span, so pipes stay separators.
      poisoned = true;
      i = j;
      continue;
    }
    if (c === 124) {
      let bs = 0, p = i - 1;
      while (p >= 0 && s.charCodeAt(p) === 92) { bs++; p--; }
      if (bs % 2 === 0) {
        cells.push(s.slice(start, i));
        start = i + 1;
      }
    }
    i++;
  }
  cells.push(s.slice(start));
  for (let k = 0; k < cells.length; k++) {
    let cell = cells[k];
    if (cell.indexOf('\\') !== -1) {
      let out = '';
      for (let q = 0; q < cell.length; q++) {
        if (cell.charCodeAt(q) === 92 && q + 1 < cell.length && cell.charCodeAt(q + 1) === 124) { out += '|'; q++; }
        else out += cell[q];
      }
      cell = out;
    }
    let x = 0, y = cell.length;
    while (x < y && isSpaceOrTab(cell.charCodeAt(x))) x++;
    while (y > x && isSpaceOrTab(cell.charCodeAt(y - 1))) y--;
    cells[k] = cell.slice(x, y);
  }
  return cells;
}

// Parse a delimiter row: yields the alignment per cell, or null when any
// cell is not a run of dashes with optional edge colons.
function delimiterCells(line) {
  const cells = splitTableRow(line);
  const aligns = new Array(cells.length);
  for (let k = 0; k < cells.length; k++) {
    const cell = cells[k];
    const m = cell.match(/^(:?)-+(:?)$/);
    if (!m) return null;
    aligns[k] = m[1] && m[2] ? 'center' : m[1] ? 'left' : m[2] ? 'right' : '';
  }
  return aligns;
}

// ------------------------------------------------------------ block parsing

function newBlock(t, ln) {
  return {
    t, children: [], lines: [],
    start: ln, end: ln, last: ln, matchEnd: ln, endHit: false,
  };
}

export function parse(markdown) {
  const lines = splitLines(markdown);
  const root = newBlock('doc', 0);
  const stack = [root];
  const refs = new Map();
  const blankSep = new Set();

  function closeBlock(b) {
    if (b.t === 'para') {
      const parent = stack[stack.length - 1];
      const result = finalizePara(b, refs);
      const idx = parent.children.length - 1;
      if (result !== b) parent.children[idx] = result;
    } else if (b.t === 'list') {
      b.tight = computeTight(b, blankSep, lines);
    }
  }
  function popTo(depth, ln) {
    while (stack.length > depth) {
      const b = stack.pop();
      if (ln !== undefined && ln >= 0) b.last = ln;
      closeBlock(b);
    }
  }

  for (let ln = 0; ln < lines.length; ln++) {
    const cur = new Cursor(lines[ln].text);
    let sepBlank = false;

    // ---- match open containers against this line ----
    let matched = 1;
    for (let si = 1; si < stack.length; si++) {
      const b = stack[si];
      if (b.t === 'quote') {
        const save = cur.clone();
        cur.skipWs(3);
        if (cur.code() === 62) {
          cur.quoteCol = cur.col;
          cur.adv(1);
          const c = cur.code();
          if (c === 32) cur.adv(1);
          else if (c === 9) {
            // The optional space after `>` may be part of a tab; the
            // tab's width is measured relative to the `>` column, so
            // the remainder is 4-((col-quoteCol)&3)-1 (doc-30: `>` at
            // col 7, tab at col 8 leaves 2 columns, not 3).
            const e = cur.col - cur.quoteCol;
            const w = 4 - (e & 3);
            if (w <= 1) { cur.i++; cur.col += w; }
            else { cur.tab = w - 1; cur.col += 1; }
          }
          matched = si + 1;
        } else {
          cur.i = save.i; cur.col = save.col; cur.tab = save.tab; cur.quoteCol = save.quoteCol;
          break;
        }
      } else if (b.t === 'item') {
        if (cur.blank()) { matched = si + 1; continue; }
        const save = cur.clone();
        const ind = cur.skipWs(b.indent);
        if (ind >= b.indent) matched = si + 1;
        else {
          cur.i = save.i; cur.col = save.col; cur.tab = save.tab; cur.quoteCol = save.quoteCol;
          break;
        }
      } else if (b.t === 'list') {
        matched = si + 1;
      } else break; // a leaf block stops container matching
    }
    const mismatch = matched < stack.length && stack[matched].t !== 'para' &&
      stack[matched].t !== 'fcode' && stack[matched].t !== 'html' && stack[matched].t !== 'icode';
    const top = stack[stack.length - 1];
    let done = false;

    if (mismatch) {
      // A fenced code block inside a list item is sticky: once it holds at
      // least one content line, lines that fail to match only list/item
      // containers still count as fence content. A failing blockquote
      // still ends it, and a mismatching first line ends it empty.
      let stickyFence = false;
      if (top.t === 'fcode' && top.lines.length > 0) {
        stickyFence = true;
        for (let si = matched; si < stack.length - 1; si++) {
          if (stack[si].t === 'quote') { stickyFence = false; break; }
        }
      }
      if (stickyFence) {
        const probe = cur.clone();
        probe.skipWs(3);
        if (!cur.blank() && probe.col - cur.col <= 3 && isClosingFence(probe.rest(), top)) {
          stack.pop();
          closeBlock(top);
        } else {
          const c2 = cur.clone();
          const stripped = c2.skipWsTabs(top.fenceIndent);
          // If indent stripping consumed columns and no quote matched
          // on this line, a following tab stays raw (doc-38, doc-13
          // line 720); with a quote, or nothing stripped, it expands
          // (doc-26/90, doc-22/1250, doc-30/1264, doc-30/674).
          const rawTab = stripped > 0 && c2.quoteCol < 0;
          top.lines.push({ text: rawTab ? c2.rest() : codeRest(c2, true), end: lines[ln].end });
        }
        done = true;
      } else if (top.t === 'para' && !cur.blank() && !startsBlock(cur)) {
        // Lazy continuation: when no container consumed any columns on
        // this line, the remainder loses its leading whitespace; when a
        // container did match (a quote, or an item that consumed part of
        // a tab), the remainder is kept verbatim — unless its leading
        // whitespace spans 4+ columns, in which case it is stripped
        // entirely. A whole leading tab expands to spaces first. A line
        // shaped like a setext underline is always neutralized with a
        // 4-space indent.
        let lineText = codeRest(cur, true);
        let s = 0;
        while (s < lineText.length && isSpaceOrTab(lineText.charCodeAt(s))) s++;
        const stripped = lineText.slice(s);
        let remCols = 0;
        {
          let cc = cur.col;
          for (let q = 0; q < s; q++) {
            if (lineText.charCodeAt(q) === 9) cc += 4 - (cc % 4);
            else cc++;
          }
          remCols = cc - cur.col;
        }
        if (setextLevel(stripped) !== 0) lineText = '    ' + stripped;
        else if (cur.col === 0 || remCols >= 4) lineText = stripped;
        top.lines.push(lineText);
        done = true;
      } else {
        popTo(matched, ln);
      }
    }

    // ---- leaf blocks consume the remainder ----
    const top2 = stack[stack.length - 1];
    if (!done && (top2.t === 'fcode' || top2.t === 'html' || top2.t === 'icode')) {
      if (top2.t === 'fcode') {
        const probe = cur.clone();
        probe.skipWs(3);
        if (!cur.blank() && probe.col - cur.col <= 3 && isClosingFence(probe.rest(), top2)) {
          stack.pop();
          closeBlock(top2);
        } else {
          const c2 = cur.clone();
          const stripped = c2.skipWsTabs(top2.fenceIndent);
          const rawTab = stripped > 0 && c2.quoteCol < 0;
          top2.lines.push({ text: rawTab ? c2.rest() : codeRest(c2, true), end: lines[ln].end });
        }
        done = true;
      } else if (top2.t === 'html') {
        if (cur.blank() && top2.htype >= 6) {
          stack.pop();
          closeBlock(top2);
          sepBlank = true;
          blankSep.add(ln);
          done = true;
        } else {
          const text = cur.rest();
          top2.lines.push({ text, end: lines[ln].end });
          top2.end = ln;
          if (top2.htype <= 5 && htmlEndHit(top2.htype, text)) {
            top2.endHit = true;
            stack.pop();
            closeBlock(top2);
          }
          done = true;
        }
      } else if (top2.t === 'icode') {
        if (cur.blank()) {
          cur.adv(4);
          top2.lines.push({ text: codeRest(cur), end: lines[ln].end });
          done = true;
        } else {
          const probe = cur.clone();
          const ind = probe.skipWs(100);
          if (ind >= 4) {
            cur.adv(4);
            top2.lines.push({ text: codeRest(cur), end: lines[ln].end });
            done = true;
          } else {
            stack.pop();
            closeBlock(top2);
          }
        }
      }
    }

    if (!done) {
      openNewBlocks(cur, ln, lines, stack, refs, blankSep, () => { sepBlank = true; });
    }

    // ---- extend the spans of everything still open ----
    for (let si = 0; si < stack.length; si++) {
      stack[si].last = ln;
      stack[si].matchEnd = ln;
      if (!sepBlank) stack[si].end = ln;
    }
  }

  popTo(0);

  const out = [];
  // Leaked anchor state: an inline `<a ...>` tag (with a space after the
  // name) suppresses GFM extended autolinks in all following inline
  // content until an inline `</a>`; threaded through rendering in
  // document order, fresh for each parse.
  const leak = { on: false };
  renderBlocks(root.children, root, out, refs, lines, leak);
  return out.join('');
}

// True when the raw line holds only spaces and tabs.
function isBlankText(text) {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// Whether the remainder starts a block that can interrupt a paragraph.
// Used for the lazy-continuation test. Any list marker counts here; the
// empty-marker and ordered-start restrictions only apply when the line is
// inside the paragraph's own container (openNewBlocks enforces those).
// Setext-shaped lines do not interrupt: they are lazy continuation lines,
// neutralized by the lazy branch.
function startsBlock(cur) {
  const probe = cur.clone();
  const ind = probe.skipWs(100);
  if (ind >= 4 || probe.atEnd()) return false;
  const rest = probe.rest();
  if (isThematicBreak(rest)) return true;
  if (parseAtx(rest)) return true;
  if (parseFence(rest)) return true;
  const ht = htmlBlockType(rest);
  if (ht !== 0 && ht !== 7) return true;
  if (rest.charCodeAt(0) === 62) return true;
  if (peekListMarker(rest)) return true;
  return false;
}

// Inspect a list marker without consuming anything: marker info or null.
function peekListMarker(rest) {
  const n = rest.length;
  if (n === 0) return null;
  const c0 = rest.charCodeAt(0);
  let ordered = false, delim = 0, start = 0, markerLen = 0;
  if (c0 === 45 || c0 === 43 || c0 === 42) markerLen = 1;
  else if (isDigit(c0)) {
    let i = 0;
    while (i < n && isDigit(rest.charCodeAt(i))) i++;
    if (i > 9) return null;
    if (i < n && (rest.charCodeAt(i) === 46 || rest.charCodeAt(i) === 41)) {
      const v = parseInt(rest.slice(0, i), 10);
      if (v > 999999999) return null;
      ordered = true;
      delim = rest.charCodeAt(i);
      start = v;
      markerLen = i + 1;
    } else return null;
  } else return null;
  if (markerLen < n && !isSpaceOrTab(rest.charCodeAt(markerLen))) return null;
  let j = markerLen;
  while (j < n && isSpaceOrTab(rest.charCodeAt(j))) j++;
  return { ordered, delim, start, empty: j >= n };
}

// Close lists sitting on top of the stack: only list items may be children
// of a list, so any other block start closes open lists first.
function closeListsOnTop(stack, blankSep, lines) {
  while (stack.length > 1 && stack[stack.length - 1].t === 'list') {
    const l = stack.pop();
    l.tight = computeTight(l, blankSep, lines);
  }
}

// Open blocks for the remainder of the current line, looping while a new
// container (blockquote, list item) is opened. `cur` is positioned just
// past the matched containers.
function openNewBlocks(cur, ln, lines, stack, refs, blankSep, markSepBlank) {
  while (true) {
    const top = stack[stack.length - 1];
    const paraOpen = top.t === 'para';
    const iterBase = cur.col;
    const probe = cur.clone();
    const ind = probe.skipWs(100);
    if (probe.atEnd()) {
      // The remainder is empty or whitespace-only.
      const rem = cur.rest();
      if (rem === '' || isBlankText(lines[ln].text)) {
        // A whitespace-only line that contains a tab, following a table
        // candidate, joins the paragraph as an empty row instead of
        // closing it; later lines keep adding rows. Space-only lines
        // still separate.
        if (paraOpen && top.lines.length >= 2 && lines[ln].text.indexOf('\t') !== -1 &&
            lineIndentCols(top.lines[1]) <= 3) {
          const aligns = delimiterCells(top.lines[1]);
          if (aligns && aligns.length === splitTableRow(top.lines[0]).length) {
            top.lines.push(rem);
            return;
          }
        }
        // Separator blank line: close the paragraph, and close empty
        // items opened on earlier lines (an item opened on this very
        // line may still gain content below).
        if (paraOpen) { stack.pop(); finalizeAndReplace(stack, top, refs, blankSep); }
        while (stack.length > 1 && stack[stack.length - 1].t === 'item' &&
               stack[stack.length - 1].children.length === 0 &&
               stack[stack.length - 1].start < ln) stack.pop();
        blankSep.add(ln);
        markSepBlank();
        return;
      }
      // A non-empty whitespace remainder on a non-blank raw line (e.g.
      // ">  ") feeds an open paragraph and is otherwise ignored.
      if (paraOpen) top.lines.push(rem);
      return;
    }
    if (ind >= 4) {
      if (paraOpen) {
        top.lines.push(codeRest(cur, true));
        return;
      }
      // Indented code.
      cur.adv(4);
      closeListsOnTop(stack, blankSep, lines);
      const parent = stack[stack.length - 1];
      const b = newBlock('icode', ln);
      b.lines.push({ text: codeRest(cur), end: lines[ln].end });
      parent.children.push(b);
      stack.push(b);
      return;
    }
    const rest = probe.rest();

    // Setext underline under an open paragraph, with a table exception:
    // leading link reference definitions are stripped first, since they
    // never become heading content.
    if (paraOpen) {
      const lvl = setextLevel(rest);
      if (lvl !== 0) {
        const pc = paraContent(top);
        const p = stripRefDefs(pc, refs);
        const remainder = pc.slice(p);
        const remLines = remainder.split('\n');
        let isTable = false;
        if (remLines.length === 1 && remLines[0].includes('|')) {
          const aligns = delimiterCells(rest);
          if (aligns && aligns.length === splitTableRow(remLines[0]).length) isTable = true;
        } else if (remLines.length >= 2 && lineIndentCols(remLines[1]) <= 3) {
          // The paragraph is already table-shaped (its second line is the
          // delimiter row): a setext-looking line is just another row.
          const aligns = delimiterCells(remLines[1]);
          if (aligns && aligns.length === splitTableRow(remLines[0]).length) isTable = true;
        }
        if (isTable || remainder.replace(/[ \t\n]/g, '') === '') {
          // Table candidate: the delimiter line joins the paragraph and
          // is converted later. Def-only paragraph: no heading; the
          // underline line joins as content.
          top.lines.push(codeRest(cur, true));
          return;
        }
        stack.pop();
        const parent = stack[stack.length - 1];
        const h = newBlock('head', top.start);
        h.level = lvl;
        let hc = remainder;
        let hs = 0;
        while (hs < hc.length && isSpaceOrTab(hc.charCodeAt(hs))) hs++;
        let he = hc.length;
        while (he > hs && isSpaceOrTab(hc.charCodeAt(he - 1))) he--;
        h.content = hc.slice(hs, he);
        h.end = ln;
        parent.children[parent.children.length - 1] = h;
        return;
      }
    }

    // Thematic break.
    if (isThematicBreak(rest)) {
      if (paraOpen) { stack.pop(); finalizeAndReplace(stack, top, refs, blankSep); }
      closeListsOnTop(stack, blankSep, lines);
      const parent = stack[stack.length - 1];
      parent.children.push(newBlock('hr', ln));
      return;
    }

    // ATX heading.
    const atx = parseAtx(rest);
    if (atx) {
      if (paraOpen) { stack.pop(); finalizeAndReplace(stack, top, refs, blankSep); }
      closeListsOnTop(stack, blankSep, lines);
      const parent = stack[stack.length - 1];
      const h = newBlock('head', ln);
      h.level = atx.level;
      h.content = atx.content;
      parent.children.push(h);
      return;
    }

    // Fenced code.
    const fence = parseFence(rest);
    if (fence) {
      if (paraOpen) { stack.pop(); finalizeAndReplace(stack, top, refs, blankSep); }
      closeListsOnTop(stack, blankSep, lines);
      const parent = stack[stack.length - 1];
      const b = newBlock('fcode', ln);
      b.ch = fence.ch;
      b.len = fence.len;
      // A tilde fence opened directly inside a blockquote keeps its
      // content lines' post-quote whitespace verbatim: the opening
      // fence's indent is not stripped from them. (Backtick fences
      // strip normally.)
      b.fenceIndent = (parent.t === 'quote' && fence.ch === 126) ? 0 : ind;
      b.info = fence.info.trim().replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
      parent.children.push(b);
      stack.push(b);
      return;
    }

    // HTML block (type 7 never interrupts a paragraph).
    const ht = htmlBlockType(rest);
    if (ht !== 0 && (ht !== 7 || !paraOpen)) {
      if (paraOpen) { stack.pop(); finalizeAndReplace(stack, top, refs, blankSep); }
      closeListsOnTop(stack, blankSep, lines);
      const parent = stack[stack.length - 1];
      const b = newBlock('html', ln);
      b.htype = ht;
      // Quote depth matters for the trailing-newline rule: a following
      // line that is blank inside the same quotes absorbs the newline
      // (doc-30: a lone `>` line after an HTML block in a quote).
      let qd = 0;
      for (const s of stack) if (s.t === 'quote') qd++;
      b.qdepth = qd;
      const text = cur.rest();
      b.lines.push({ text, end: lines[ln].end });
      parent.children.push(b);
      stack.push(b);
      if (ht <= 5 && htmlEndHit(ht, text)) { b.endHit = true; stack.pop(); }
      return;
    }

    // Blockquote.
    if (rest.charCodeAt(0) === 62) {
      if (paraOpen) { stack.pop(); finalizeAndReplace(stack, top, refs, blankSep); }
      closeListsOnTop(stack, blankSep, lines);
      const parent = stack[stack.length - 1];
      cur.skipWs(3);
      cur.adv(1);
      const c = cur.code();
      if (c === 32 || c === 9) cur.adv(1);
      const b = newBlock('quote', ln);
      parent.children.push(b);
      stack.push(b);
      continue;
    }

    // List item.
    const m = peekListMarker(rest);
    if (m) {
      // Ordered lists starting at 1 interrupt paragraphs anywhere; other
      // start numbers interrupt only when the paragraph is nested inside
      // a blockquote or a list item.
      let nested = false;
      if (paraOpen) {
        for (let si = 1; si < stack.length - 1; si++) {
          if (stack[si].t === 'quote' || stack[si].t === 'item') { nested = true; break; }
        }
      }
      const canInterrupt = !paraOpen || (!m.empty && (!m.ordered || m.start === 1 || nested));
      if (canInterrupt) {
        if (paraOpen) { stack.pop(); finalizeAndReplace(stack, top, refs, blankSep); }
        let parent = stack[stack.length - 1];
        cur.skipWs(ind);
        const marker = parseListMarker(cur, cur.rest());
        let list = null;
        if (parent.t === 'list') {
          const same = parent.ordered === marker.ordered &&
            (marker.ordered ? parent.delim === marker.delim : parent.bullet === marker.bullet);
          if (same) list = parent;
          else {
            const old = stack.pop();
            old.tight = computeTight(old, blankSep, lines);
            parent = stack[stack.length - 1];
          }
        }
        if (!list) {
          list = newBlock('list', ln);
          list.ordered = marker.ordered;
          list.delim = marker.delim;
          list.bullet = marker.bullet;
          list.startNum = marker.start;
          parent.children.push(list);
          stack.push(list);
        }
        const item = newBlock('item', ln);
        // The content indent is relative to the position just past the
        // enclosing containers on this line.
        item.indent = marker.contentIndent - iterBase;
        list.children.push(item);
        stack.push(item);
        continue;
      }
      // Otherwise the line continues the paragraph.
    }

    // Paragraph: new, or a continuation line. A whole leading tab
    // expands to spaces (same rule as fenced code content).
    if (!paraOpen) {
      closeListsOnTop(stack, blankSep, lines);
      const parent = stack[stack.length - 1];
      const b = newBlock('para', ln);
      b.lines.push(codeRest(cur, true));
      parent.children.push(b);
      stack.push(b);
    } else {
      top.lines.push(codeRest(cur, true));
    }
    return;
  }
}

// Finalize a paragraph that was just popped: strip its reference
// definitions and test for a table. The paragraph is the last child of
// its parent (the stack top). A paragraph fully consumed by definitions
// becomes a 'removed' block: it renders nothing but keeps its line span
// for looseness computation.
function finalizeAndReplace(stack, para, refs, blankSep) {
  const parent = stack[stack.length - 1];
  const result = finalizePara(para, refs);
  const idx = parent.children.length - 1;
  if (result !== para) parent.children[idx] = result;
}

// Paragraph content: lines joined with newlines, verbatim (trailing
// spaces are kept — they can mean hard breaks).
function paraContent(para) {
  return para.lines.join('\n');
}

// Consume consecutive link reference definitions from the start of text,
// collecting them into refs. Returns the offset just past the last one.
// The first definition of a label wins.
function stripRefDefs(text, refs) {
  let p = 0;
  const n = text.length;
  while (p < n) {
    const r = parseRefDef(text, p);
    if (!r) break;
    const label = normalizeLabel(r.label);
    if (label !== '' && !refs.has(label)) refs.set(label, { dest: r.dest, title: r.title });
    p = r.end;
  }
  return p;
}

// Strip leading reference definitions from a paragraph and check whether
// what remains is a table. Returns the paragraph block, a table block, or
// a 'removed' block when definitions consumed everything.
function finalizePara(para, refs) {
  const text = para.lines.join('\n');
  const p = stripRefDefs(text, refs);
  if (p > 0) {
    const rest = text.slice(p);
    if (rest.replace(/[ \t\n]/g, '') === '') {
      const r = newBlock('removed', para.start);
      r.end = para.end;
      r.matchEnd = para.matchEnd;
      return r;
    }
    para.lines = rest.split('\n');
  }
  if (para.lines.length >= 2 && lineIndentCols(para.lines[1]) <= 3) {
    const header = para.lines[0];
    const aligns = delimiterCells(para.lines[1]);
    if (aligns) {
      const headerCells = splitTableRow(header);
      if (headerCells.length === aligns.length) {
        const table = newBlock('table', para.start);
        table.header = headerCells;
        table.aligns = aligns;
        table.rows = [];
        for (let i = 2; i < para.lines.length; i++) {
          const cells = splitTableRow(para.lines[i]);
          while (cells.length < headerCells.length) cells.push('');
          if (cells.length > headerCells.length) cells.length = headerCells.length;
          table.rows.push(cells);
        }
        table.end = para.end;
        return table;
      }
    }
  }
  return para;
}

// Parse one link reference definition starting at text[p].
// Yields {label, dest, title, end} or null; end sits just past the
// definition's final line ending.
function parseRefDef(text, p) {
  const n = text.length;
  let i = p;
  let ind = 0;
  while (i < n && ind < 3 && text.charCodeAt(i) === 32) { i++; ind++; }
  if (i >= n || text.charCodeAt(i) !== 91) return null;
  let labelStart = i + 1, j = i + 1;
  let labelEnd = -1;
  while (j < n) {
    const c = text.charCodeAt(j);
    if (c === 92 && j + 1 < n && isAsciiPunct(text.charCodeAt(j + 1))) { j += 2; continue; }
    if (c === 91) return null;
    if (c === 93) { labelEnd = j; break; }
    j++;
  }
  if (labelEnd === -1) return null;
  const labelRaw = text.slice(labelStart, labelEnd);
  if (labelRaw.length === 0 || labelRaw.length > 999) return null;
  if (normalizeLabel(labelRaw) === '') return null;
  j = labelEnd + 1;
  while (j < n) {
    const c = text.charCodeAt(j);
    if (c === 32 || c === 9 || c === 10) j++;
    else break;
  }
  if (j >= n || text.charCodeAt(j) !== 58) return null;
  j++;
  while (j < n) {
    const c = text.charCodeAt(j);
    if (c === 32 || c === 9 || c === 10) j++;
    else break;
  }
  // Destination: <...> or a bare run with balanced parentheses.
  let dest = '';
  if (j < n && text.charCodeAt(j) === 60) {
    j++;
    const ds = j;
    let ok = false;
    while (j < n) {
      const c = text.charCodeAt(j);
      if (c === 62) { ok = true; break; }
      if (c === 60 || c === 10 || c < 32) return null;
      if (c === 92 && j + 1 < n && isAsciiPunct(text.charCodeAt(j + 1))) { j += 2; continue; }
      j++;
    }
    if (!ok) return null;
    dest = unescapeBackslashes(text.slice(ds, j));
    j++;
  } else {
    const ds = j;
    let depth = 0;
    while (j < n) {
      const c = text.charCodeAt(j);
      if (c === 32 || c === 9 || c === 10 || c < 32) break;
      if (c === 92 && j + 1 < n && isAsciiPunct(text.charCodeAt(j + 1))) { j += 2; continue; }
      if (c === 40) depth++;
      else if (c === 41) {
        if (depth === 0) break;
        depth--;
      }
      j++;
    }
    if (depth !== 0) return null;
    if (j === ds) return null;
    dest = unescapeBackslashes(text.slice(ds, j));
  }
  // After the destination: spaces/tabs on this line, then either the line
  // ends (the definition may end here, or a title may follow on the next
  // line) or a title on this line. A same-line title needs whitespace
  // between it and the destination.
  let k = j;
  while (k < n && isSpaceOrTab(text.charCodeAt(k))) k++;
  let title = null;
  let titleStart = -1;
  let titleOnNextLine = false;
  let eolEnd = -1;
  if (k < n && text.charCodeAt(k) === 10) {
    eolEnd = k + 1;
    let k2 = k + 1;
    while (k2 < n && isSpaceOrTab(text.charCodeAt(k2))) k2++;
    const q2 = k2 < n ? text.charCodeAt(k2) : -1;
    if (q2 === 34 || q2 === 39 || q2 === 40) { titleStart = k2; titleOnNextLine = true; }
    else return { label: labelRaw, dest, title: null, end: k + 1 };
  } else if (k >= n) {
    return { label: labelRaw, dest, title: null, end: k };
  } else {
    if (k === j) return null;
    const q = text.charCodeAt(k);
    if (q === 34 || q === 39 || q === 40) titleStart = k;
    else return null;
  }
  // Parse the title, which may span lines with newlines kept verbatim.
  // When a next-line title fails, the definition still stands without it.
  const rollback = () => ({ label: labelRaw, dest, title: null, end: eolEnd });
  {
    const q = text.charCodeAt(titleStart);
    const close = q === 40 ? 41 : q;
    let t = titleStart + 1;
    let tstr = '';
    let closed = false;
    while (t < n) {
      const c = text.charCodeAt(t);
      if (c === close) { closed = true; break; }
      if (q === 40 && c === 40) return titleOnNextLine ? rollback() : null;
      if (c === 92 && t + 1 < n && isAsciiPunct(text.charCodeAt(t + 1))) { tstr += text[t + 1]; t += 2; continue; }
      tstr += text[t];
      t++;
    }
    if (!closed) return titleOnNextLine ? rollback() : null;
    title = tstr;
    k = t + 1;
  }
  while (k < n && isSpaceOrTab(text.charCodeAt(k))) k++;
  if (k < n && text.charCodeAt(k) !== 10) return titleOnNextLine ? rollback() : null;
  if (k < n) k++;
  return { label: labelRaw, dest, title, end: k };
}

// Visual columns of a line's leading whitespace (tabs to multiples of 4).
function lineIndentCols(line) {
  let col = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c === 32) col++;
    else if (c === 9) col += 4 - (col & 3);
    else break;
  }
  return col;
}

// A list is tight when no separator blank line sits uncovered between any
// two sibling blocks of an item, or between consecutive items.
function computeTight(list, blankSep, lines) {
  const items = list.children;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    for (let j = 1; j < it.children.length; j++) {
      if (hasUncoveredBlank(blankSep, it.children[j - 1].end, it.children[j].start, it.children, lines)) return false;
    }
    if (i + 1 < items.length) {
      if (hasUncoveredBlank(blankSep, it.end, items[i + 1].start, it.children, lines)) return false;
    }
  }
  return true;
}

// Whether a separator blank line strictly between endLine and startLine is
// not covered by one of the given sibling blocks. A blank is covered only
// when it lies inside a sibling's matched span and the raw line is not
// itself blank (raw blank lines always separate; lines like "> " inside a
// blockquote can be covered).
function hasUncoveredBlank(set, endLine, startLine, siblings, lines) {
  for (let k = endLine + 1; k < startLine; k++) {
    if (!set.has(k)) continue;
    if (isBlankText(lines[k].text)) return true;
    let covered = false;
    for (const s of siblings) {
      if (k >= s.start && k <= (s.matchEnd !== undefined ? s.matchEnd : s.end)) { covered = true; break; }
    }
    if (!covered) return true;
  }
  return false;
}

// -------------------------------------------------------------- rendering

function renderBlocks(children, parent, out, refs, lines, leak) {
  for (const b of children) {
    if (b.t === 'removed') continue;
    renderBlock(b, parent, out, refs, lines, leak);
  }
}

function renderBlock(b, parent, out, refs, lines, leak) {
  switch (b.t) {
    case 'para':
      out.push('<p>', renderInline(paraContent(b), refs, leak), '</p>\n');
      break;
    case 'head':
      out.push('<h', String(b.level), '>', renderInline(b.content, refs, leak), '</h', String(b.level), '>\n');
      break;
    case 'hr':
      out.push('<hr>\n');
      break;
    case 'quote':
      out.push('<blockquote>\n');
      renderBlocks(b.children, b, out, refs, lines, leak);
      out.push('</blockquote>\n');
      break;
    case 'list': {
      if (b.ordered) {
        out.push('<ol');
        if (b.startNum !== 1) out.push(' start="', String(b.startNum), '"');
        out.push('>\n');
      } else out.push('<ul>\n');
      for (const item of b.children) renderItem(item, b.tight, out, refs, lines, leak);
      out.push(b.ordered ? '</ol>\n' : '</ul>\n');
      break;
    }
    case 'fcode': {
      const info = b.info || '';
      const word = unescapeBackslashes(info.split(/[ \t]/, 1)[0]);
      out.push('<pre><code');
      if (word !== '') out.push(' class="language-', escapeHtml(word, false), '"');
      out.push('>', escapeHtml(codeContent(b.lines), true), '</code></pre>\n');
      break;
    }
    case 'icode': {
      const ls = b.lines.slice();
      while (ls.length > 0 && ls[ls.length - 1].text.trim() === '') ls.pop();
      out.push('<pre><code>', escapeHtml(codeContent(ls), true), '</code></pre>\n');
      break;
    }
    case 'html': {
      let s = b.lines.map(l => l.text).join('\n');
      const lastLine = b.lines[b.lines.length - 1];
      // A trailing newline is emitted when the last line had an ending
      // and either the block ended at its end marker with no truly empty
      // line after it, or it runs to the last line of the input. A lone
      // tab on the next line does not absorb the newline.
      if (lastLine && lastLine.end) {
        if (b.endHit) {
          const nxt = lines[b.end + 1];
          if (!nxt || !htmlNextAbsorbs(nxt.text, b.qdepth || 0)) s += '\n';
        } else if (b.end === lines.length - 1) {
          s += '\n';
        }
      }
      out.push(s);
      break;
    }
    case 'table': {
      out.push('<table>\n<thead>\n<tr>\n');
      for (let i = 0; i < b.header.length; i++) {
        out.push('<th');
        if (b.aligns[i]) out.push(' align="', b.aligns[i], '"');
        out.push('>', renderInline(b.header[i], refs, leak), '</th>\n');
      }
      out.push('</tr>\n</thead>\n');
      if (b.rows.length > 0) {
        out.push('<tbody>');
        for (const row of b.rows) {
          out.push('<tr>\n');
          for (let i = 0; i < row.length; i++) {
            out.push('<td');
            if (b.aligns[i]) out.push(' align="', b.aligns[i], '"');
            out.push('>', renderInline(row[i], refs, leak), '</td>\n');
          }
          out.push('</tr>\n');
        }
        out.push('</tbody>');
      }
      out.push('</table>\n');
      break;
    }
  }
}

// Join code-block lines; a trailing newline appears when the last line
// had an ending and is non-empty.
function codeContent(ls) {
  if (ls.length === 0) return '';
  const s = ls.map(l => l.text).join('\n');
  const last = ls[ls.length - 1];
  if (last.end && last.text !== '') return s + '\n';
  return s;
}

function renderItem(item, tight, out, refs, lines, leak) {
  out.push('<li>');
  const kids = item.children.filter(k => k.t !== 'removed');
  for (let i = 0; i < kids.length; i++) {
    const k = kids[i];
    if (k.t === 'para' && tight) {
      let content = paraContent(k);
      if (i === 0) {
        const m = content.match(/^\[( |x|X)\][ \t]/);
        if (m) {
          const checked = m[1] === 'x' || m[1] === 'X';
          out.push(checked ? '<input checked="" disabled="" type="checkbox">' : '<input disabled="" type="checkbox">');
          content = content.slice(3);
          out.push(renderInline(content, refs, leak));
          continue;
        }
      }
      out.push(renderInline(content, refs, leak));
    } else if (k.t === 'para' && i === 0) {
      let content = paraContent(k);
      const m = content.match(/^\[( |x|X)\][ \t]/);
      out.push('<p>');
      if (m) {
        const checked = m[1] === 'x' || m[1] === 'X';
        out.push(checked ? '<input checked="" disabled="" type="checkbox">' : '<input disabled="" type="checkbox">');
        content = content.slice(3);
      }
      out.push(renderInline(content, refs, leak), '</p>\n');
    } else {
      renderBlock(k, item, out, refs, lines, leak);
    }
  }
  out.push('</li>\n');
}

// ---------------------------------------------------------- inline scanning
// The inline parser scans once, building nodes (text, code spans, raw HTML,
// hard breaks, autolinks, delimiter runs, brackets, links and images), then
// resolves emphasis with the delimiter-stack algorithm and renders.

const WS_CH_RE = /\s/u;
const PUNCT_CH_RE = /[\p{P}\p{S}]/u;

// The whole Unicode character just before / at an index (surrogate-aware).
function charBefore(text, i) {
  if (i <= 0) return '';
  const c = text.charCodeAt(i - 1);
  if (c >= 0xDC00 && c <= 0xDFFF && i >= 2) {
    const h = text.charCodeAt(i - 2);
    if (h >= 0xD800 && h <= 0xDBFF) return text.slice(i - 2, i);
  }
  return text[i - 1];
}
function charAfter(text, i) {
  if (i >= text.length) return '';
  const c = text.charCodeAt(i);
  if (c >= 0xD800 && c <= 0xDBFF && i + 1 < text.length) {
    const l = text.charCodeAt(i + 1);
    if (l >= 0xDC00 && l <= 0xDFFF) return text.slice(i, i + 2);
  }
  return text[i];
}
function isSpaceCh(ch) { return ch === '' || WS_CH_RE.test(ch); }
function isPunctCh(ch) { return ch !== '' && PUNCT_CH_RE.test(ch); }

// Length of the raw-HTML construct starting at text[i] ('<'), or 0.
function inlineHtmlLen(text, i) {
  const n = text.length;
  let j = i + 1;
  if (j >= n) return 0;
  const c = text.charCodeAt(j);
  if (c === 33) {
    if (text.startsWith('<!-->', i)) return 5;
    if (text.startsWith('<!--->', i)) return 6;
    if (text.startsWith('<!--', i)) {
      const k = text.indexOf('-->', i + 4);
      return k === -1 ? 0 : k + 3 - i;
    }
    if (text.startsWith('<![CDATA[', i)) {
      const k = text.indexOf(']]>', i + 9);
      return k === -1 ? 0 : k + 3 - i;
    }
    if (j + 1 < n && text.charCodeAt(j + 1) >= 65 && text.charCodeAt(j + 1) <= 90) {
      const k = text.indexOf('>', j + 2);
      return k === -1 ? 0 : k + 1 - i;
    }
    return 0;
  }
  if (c === 63) {
    const k = text.indexOf('?>', i + 2);
    return k === -1 ? 0 : k + 2 - i;
  }
  let k = j, closing = false;
  if (text.charCodeAt(k) === 47) { closing = true; k++; }
  if (k >= n || !isAlpha(text.charCodeAt(k))) return 0;
  while (k < n && (isAlnum(text.charCodeAt(k)) || text.charCodeAt(k) === 45)) k++;
  const skipWs = () => {
    let w = 0;
    while (k < n) {
      const d = text.charCodeAt(k);
      if (d === 32 || d === 9 || d === 10) { k++; w++; }
      else break;
    }
    return w;
  };
  if (closing) {
    skipWs();
    if (k < n && text.charCodeAt(k) === 62) return k + 1 - i;
    return 0;
  }
  // Attributes: each needs whitespace separating it from the previous token.
  let lastEnd = k;
  while (true) {
    skipWs();
    if (k >= n) return 0;
    const d = text.charCodeAt(k);
    if (d === 62) return k + 1 - i;
    if (d === 47) {
      k++;
      if (k < n && text.charCodeAt(k) === 62) return k + 1 - i;
      return 0;
    }
    if (k <= lastEnd) return 0;
    if (!(isAlpha(d) || d === 95 || d === 58)) return 0;
    k++;
    while (k < n) {
      const e = text.charCodeAt(k);
      if (isAlnum(e) || e === 95 || e === 58 || e === 45 || e === 46) k++;
      else break;
    }
    lastEnd = k;
    skipWs();
    if (k < n && text.charCodeAt(k) === 61) {
      k++;
      skipWs();
      if (k >= n) return 0;
      const q = text.charCodeAt(k);
      if (q === 34 || q === 39) {
        k++;
        while (k < n && text.charCodeAt(k) !== q) k++;
        if (k >= n) return 0;
        k++;
      } else {
        let seen = false;
        while (k < n) {
          const e = text.charCodeAt(k);
          if (e === 32 || e === 9 || e === 10 || e === 34 || e === 39 || e === 61 || e === 60 || e === 62 || e === 96) break;
          seen = true;
          k++;
        }
        if (!seen) return 0;
      }
      lastEnd = k;
    }
  }
}

function isEmailLocalChar(c) {
  return isAlnum(c) || c === 46 || c === 33 || c === 35 || c === 36 || c === 37 || c === 38 ||
    c === 39 || c === 42 || c === 43 || c === 47 || c === 61 || c === 63 || c === 94 ||
    c === 95 || c === 96 || c === 123 || c === 124 || c === 125 || c === 126 || c === 45;
}

// Validate an <...> email address: labels start and end alnum, at most 63
// characters each; no dot is required.
function validAngleEmail(email) {
  const at = email.indexOf('@');
  if (at <= 0) return false;
  for (let k = 0; k < at; k++) if (!isEmailLocalChar(email.charCodeAt(k))) return false;
  const dom = email.slice(at + 1);
  if (dom.length === 0) return false;
  let labelStart = true, labelLen = 0, prevDash = false;
  for (let k = 0; k <= dom.length; k++) {
    const c = k < dom.length ? dom.charCodeAt(k) : 46;
    if (c === 46) {
      if (labelLen === 0 || prevDash) return false;
      labelStart = true;
      labelLen = 0;
      prevDash = false;
    } else if (isAlnum(c) || c === 45) {
      if (labelStart && c === 45) return false;
      labelStart = false;
      labelLen++;
      prevDash = c === 45;
      if (labelLen > 63) return false;
    } else return false;
  }
  return true;
}

// An angle autolink <scheme:...> or <email> starting at text[i] ('<').
// Yields {dest, text, len} (dest carries 'mailto:' for email) or null.
function angleAutolink(text, i) {
  const n = text.length;
  const j = i + 1;
  if (j < n && isAlpha(text.charCodeAt(j))) {
    let k = j;
    while (k < n && k - j < 32) {
      const c = text.charCodeAt(k);
      if (isAlnum(c) || c === 43 || c === 45 || c === 46) k++;
      else break;
    }
    if (k - j >= 2 && k < n && text.charCodeAt(k) === 58) {
      let m = k + 1;
      while (m < n) {
        const c = text.charCodeAt(m);
        if (c === 62) {
          const dest = text.slice(i + 1, m);
          return { dest, text: dest, len: m - i + 1 };
        }
        if (c === 32 || c === 10 || c === 60 || c < 32) break;
        m++;
      }
    }
  }
  let m = j, at = -1;
  while (m < n) {
    const c = text.charCodeAt(m);
    if (c === 62) {
      if (at !== -1) {
        const email = text.slice(i + 1, m);
        if (validAngleEmail(email)) return { dest: 'mailto:' + email, text: email, len: m - i + 1 };
      }
      return null;
    }
    if (c === 32 || c === 10 || c === 60 || c < 32) return null;
    if (c === 64) { if (at !== -1) return null; at = m; }
    m++;
  }
  return null;
}

// Scan a domain for extended autolinks starting at j: labels start and end
// alnum, at least one dot. Returns the end index or -1.
function scanDomain(text, j) {
  const n = text.length;
  let dots = 0, k = j;
  for (;;) {
    if (k >= n || !isAlnum(text.charCodeAt(k))) return -1;
    let m = k;
    while (m < n && (isAlnum(text.charCodeAt(m)) || text.charCodeAt(m) === 45)) m++;
    let e = m;
    while (e > k && text.charCodeAt(e - 1) === 45) e--;
    k = e;
    if (k < n && text.charCodeAt(k) === 46 && k + 1 < n && isAlnum(text.charCodeAt(k + 1))) {
      dots++;
      k++;
      continue;
    }
    break;
  }
  if (dots < 1) return -1;
  return k;
}

// A bare email address starting at i: end index or -1. A domain followed
// immediately by '-' invalidates the whole address. A domain followed by
// '_' is only tentative: the address links when the '_' run pairs as an
// emphasis delimiter, and stays plain otherwise (resolved after emphasis
// processing, since pairing is only known then).
function scanEmail(text, i) {
  const n = text.length;
  const c0 = text.charCodeAt(i);
  if (!isEmailLocalChar(c0) || c0 === 46) return -1;
  let k = i;
  while (k < n && isEmailLocalChar(text.charCodeAt(k))) k++;
  if (k >= n || text.charCodeAt(k) !== 64) return -1;
  const dend = scanDomain(text, k + 1);
  if (dend === -1) return -1;
  if (dend < n && text.charCodeAt(dend) === 45) return -1;
  return dend;
}

function isTrailPunct(c) {
  return c === 63 || c === 33 || c === 46 || c === 44 || c === 58 || c === 59 ||
    c === 42 || c === 95 || c === 126;
}

// Trim the end of an extended autolink: an entity-like suffix, trailing
// punctuation, and unbalanced closing parentheses. Repeats until stable.
// A ']' inside resets the paren balance.
function trimAutolinkEnd(text, start, end) {
  for (;;) {
    const before = end;
    if (end > start && text.charCodeAt(end - 1) === 59) {
      let k = end - 2;
      while (k >= start && (isAlnum(text.charCodeAt(k)) || text.charCodeAt(k) === 35)) k--;
      if (k >= start && text.charCodeAt(k) === 38 && k + 1 < end - 1) end = k;
    }
    while (end > start && isTrailPunct(text.charCodeAt(end - 1))) end--;
    let opens = 0, closes = 0;
    for (let k = start; k < end; k++) {
      const c = text.charCodeAt(k);
      if (c === 40) opens++;
      else if (c === 41) closes++;
      else if (c === 93) { opens = 0; closes = 0; }
    }
    while (end > start && text.charCodeAt(end - 1) === 41 && closes > opens) { end--; closes--; }
    if (end === before) break;
  }
  return end;
}

// Whether an autolink starts at text[p]: a 'www.' prefix or a URI scheme.
function looksLikeAutolinkStart(text, p) {
  const n = text.length;
  if (p + 4 <= n && text.slice(p, p + 4) === 'www.') return true;
  if (p >= n || !isAlpha(text.charCodeAt(p))) return false;
  let k = p + 1;
  while (k < n && k - p < 32 &&
    (isAlnum(text.charCodeAt(k)) || text.charCodeAt(k) === 43 || text.charCodeAt(k) === 45 || text.charCodeAt(k) === 46)) k++;
  return k - p >= 2 && k < n && text.charCodeAt(k) === 58;
}

// Whether the parenthesized group starting at text[m] ('(') contains
// whitespace before its matching ')'. A group with whitespace (e.g. a
// "(dest title)" shape) is not consumed as part of a URI tail.
function parenGroupHasSpace(text, m) {
  const n = text.length;
  let d = 1, p = m + 1;
  while (p < n) {
    const c = text.charCodeAt(p);
    if (c === 32 || c === 10 || c === 9 || c === 60 || c < 32) return true;
    if (c === 93) return false;
    if (c === 40) d++;
    else if (c === 41) { d--; if (d === 0) return false; }
    p++;
  }
  return false;
}

// Scan a URI tail from m, stopping at whitespace, '<', a control character,
// or a ']' that would close a link (see linkCheck). Stops at '(' when the
// paren depth has gone negative or when the group it opens contains
// whitespace before its matching ')'. With stopSlash, '/' also ends the
// scan. linkCheck is consulted only at the first ']'; a consumed ']'
// resets the paren depth. initAlnum records that the URL already holds
// alphanumeric content, which licenses consuming a trailing
// backslash-newline.
function scanUriTail(text, m, stopSlash, linkCheck, initAlnum) {
  const n = text.length;
  let depth = 0;
  let checked = false;
  let hasAlnum = !!initAlnum;
  while (m < n) {
    const c = text.charCodeAt(m);
    if (c === 32 || c === 10 || c === 9 || c === 60 || c < 32) break;
    if (c === 92 && m + 1 < n && text.charCodeAt(m + 1) === 10 && !hasAlnum) break;
    if (c === 93) {
      if (!checked && linkCheck && linkCheck(m)) break;
      checked = true;
      depth = 0;
    }
    if (stopSlash && c === 47) break;
    if (c === 40) {
      if (depth < 0) break;
      if (parenGroupHasSpace(text, m)) break;
      depth++;
    } else if (c === 41) depth--;
    else if (isAlnum(c)) hasAlnum = true;
    m++;
  }
  return m;
}

function matchWww(text, i, linkCheck) {
  const dend = scanDomain(text, i + 4);
  if (dend === -1) return null;
  const n = text.length;
  let end = dend;
  if (end < n && text.charCodeAt(end) === 47) {
    end = scanUriTail(text, end, false, linkCheck, true);
  }
  // A backslash-newline right after the domain (possibly after trailing
  // punctuation) is swallowed into the link: the backslash becomes part
  // of the URL and no hard break is emitted.
  let q = end;
  while (q < n && isTrailPunct(text.charCodeAt(q))) q++;
  if (q + 1 < n && text.charCodeAt(q) === 92 && text.charCodeAt(q + 1) === 10) end = q + 1;
  end = trimAutolinkEnd(text, i, end);
  if (end <= i + 4) return null;
  const raw = text.slice(i, end);
  const href = cleanUrl('http://' + raw);
  if (href === null) return null;
  return { href: escapeHtml(href, false), text: escapeHtml(raw, true), end };
}

function matchScheme(text, i, linkCheck) {
  const n = text.length;
  if (!isAlpha(text.charCodeAt(i))) return null;
  let k = i + 1;
  while (k < n && k - i < 32 &&
    (isAlnum(text.charCodeAt(k)) || text.charCodeAt(k) === 43 || text.charCodeAt(k) === 45 || text.charCodeAt(k) === 46)) k++;
  if (k - i < 2 || k >= n || text.charCodeAt(k) !== 58) return null;
  const after = k + 1;
  if (after >= n) return null;
  // When what follows looks like the start of an email address, the email
  // rules decide: a failed email match means no autolink at all.
  let g = after;
  while (g < n && isEmailLocalChar(text.charCodeAt(g)) && text.charCodeAt(g) !== 47) g++;
  const emailApplies = g > after && g < n && text.charCodeAt(g) === 64;
  let end;
  const emEnd = emailApplies ? scanEmail(text, after) : -1;
  if (emailApplies && emEnd === -1) return null;
  if (emEnd !== -1) {
    end = emEnd;
    if (end < n && text.charCodeAt(end) === 47) {
      const m = scanUriTail(text, end + 1, true, linkCheck);
      if (m > end + 1) end = m;
    }
  } else {
    end = scanUriTail(text, after, false, linkCheck);
    if (end === after) return null;
  }
  end = trimAutolinkEnd(text, i, end);
  if (end <= after) return null;
  const raw = text.slice(i, end);
  const href = cleanUrl(raw);
  if (href === null) return null;
  return { href: escapeHtml(href, false), text: escapeHtml(raw, true), end, email: emEnd !== -1 };
}

function matchEmail(text, i) {
  let end = scanEmail(text, i);
  if (end === -1) return null;
  end = trimAutolinkEnd(text, i, end);
  if (end <= i) return null;
  const raw = text.slice(i, end);
  const href = cleanUrl('mailto:' + raw);
  if (href === null) return null;
  return { href: escapeHtml(href, false), text: escapeHtml(raw, true), end, email: true };
}

function extendedAutolink(text, i, linkCheck) {
  if (i + 4 <= text.length && text.slice(i, i + 4) === 'www.') {
    const r = matchWww(text, i, linkCheck);
    if (r) return r;
  }
  const sc = matchScheme(text, i, linkCheck);
  if (sc) return sc;
  return matchEmail(text, i);
}

// The character before an extended autolink must be the start, whitespace,
// or ASCII punctuation.
function prevCharRule(text, i) {
  if (i === 0) return true;
  const c = text.charCodeAt(i - 1);
  return c === 32 || c === 10 || c === 9 || isAsciiPunct(c);
}

// ------------------------------------------------------------ inline links

function skipLinkWs(text, p) {
  const n = text.length;
  while (p < n) {
    const c = text.charCodeAt(p);
    if (c === 32 || c === 9 || c === 10) p++;
    else break;
  }
  return p;
}

// Parse a link title starting at p: "...", '...', or (...). Yields
// {title, end} or null. Titles may span lines; a '(' title may not nest.
function parseLinkTitle(text, p) {
  const n = text.length;
  const c = text.charCodeAt(p);
  let closer, paren = false;
  if (c === 34) closer = 34;
  else if (c === 39) closer = 39;
  else if (c === 40) { closer = 41; paren = true; }
  else return null;
  let q = p + 1, out = '';
  while (q < n) {
    const ch = text.charCodeAt(q);
    if (ch === 92 && q + 1 < n && isAsciiPunct(text.charCodeAt(q + 1))) { out += text[q + 1]; q += 2; continue; }
    if (ch === closer) return { title: out, end: q + 1 };
    if (paren && ch === 40) return null;
    out += text[q];
    q++;
  }
  return null;
}

// Parse "(dest title)" starting at text[i] === '('. Yields
// {dest, title, end} or null.
function parseInlineLink(text, i) {
  const n = text.length;
  let p = skipLinkWs(text, i + 1);
  let dest = '';
  if (p < n && text.charCodeAt(p) === 60) {
    p++;
    const st = p;
    let ok = false;
    while (p < n) {
      const c = text.charCodeAt(p);
      if (c === 62) { ok = true; break; }
      if (c === 60 || c === 10 || c < 32) return null;
      if (c === 92 && p + 1 < n && isAsciiPunct(text.charCodeAt(p + 1))) p += 2;
      else p++;
    }
    if (!ok) return null;
    dest = unescapeBackslashes(text.slice(st, p));
    p++;
  } else {
    let depth = 0;
    const st = p;
    while (p < n) {
      const c = text.charCodeAt(p);
      if (c === 92 && p + 1 < n && isAsciiPunct(text.charCodeAt(p + 1))) { p += 2; continue; }
      if (c === 32 || c === 9 || c === 10 || c < 32) break;
      if (c === 40) depth++;
      else if (c === 41) {
        if (depth === 0) break;
        depth--;
      }
      p++;
    }
    dest = unescapeBackslashes(text.slice(st, p));
  }
  let q = skipLinkWs(text, p);
  let title = null;
  if (q < n && text.charCodeAt(q) === 41) return { dest, title, end: q + 1 };
  const t = parseLinkTitle(text, q);
  if (!t) return null;
  title = t.title;
  q = skipLinkWs(text, t.end);
  if (q < n && text.charCodeAt(q) === 41) return { dest, title, end: q + 1 };
  return null;
}

// Parse "[label]" starting at text[p] === '['. Yields {label, end} or null.
// Labels may not hold an unescaped '[' and are at most 999 characters.
function parseLinkLabel(text, p) {
  const n = text.length;
  let q = p + 1;
  const st = q;
  while (q < n) {
    const c = text.charCodeAt(q);
    if (c === 92 && q + 1 < n && isAsciiPunct(text.charCodeAt(q + 1))) { q += 2; continue; }
    if (c === 91) return null;
    if (c === 93) {
      const raw = text.slice(st, q);
      if (raw.length > 999) return null;
      return { label: raw, end: q + 1 };
    }
    q++;
  }
  return null;
}

// Resolve a link at a closing bracket: try the inline form, then a full or
// collapsed reference, then the shortcut form. Yields {dest, title, end,
// form} or null.
function tryLink(text, closerPos, op, refs) {
  const n = text.length;
  const p = closerPos + 1;
  if (p < n && text.charCodeAt(p) === 40) {
    const r = parseInlineLink(text, p);
    if (r) return { dest: r.dest, title: r.title, end: r.end, form: 'inline' };
  }
  if (p < n && text.charCodeAt(p) === 91) {
    const lab = parseLinkLabel(text, p);
    if (!lab) return null;
    const collapsed = lab.label === '';
    const key = collapsed
      ? normalizeLabel(text.slice(op.textStart, closerPos))
      : normalizeLabel(lab.label);
    if (key === '') return null;
    const ref = refs.get(key);
    if (!ref) return null;
    return { dest: ref.dest, title: ref.title, end: lab.end, form: collapsed ? 'collapsed' : 'full' };
  }
  const key = normalizeLabel(text.slice(op.textStart, closerPos));
  if (key === '') return null;
  const ref = refs.get(key);
  if (!ref) return null;
  return { dest: ref.dest, title: ref.title, end: closerPos + 1, form: 'shortcut' };
}

// Lengths of the backtick runs in text[start..end) that do not pair into
// a code span within the range, plus the run count: a run pairs with the
// next run of the same length, consuming everything between them; a run
// with no equal-length run after it stays unpaired.
function unpairedRunLens(text, start, end) {
  const runs = [];
  let i = start;
  while (i < end) {
    if (text.charCodeAt(i) === 96) {
      let j = i;
      while (j < end && text.charCodeAt(j) === 96) j++;
      runs.push(j - i);
      i = j;
    } else i++;
  }
  const unpaired = new Set();
  const used = new Uint8Array(runs.length);
  for (let k = 0; k < runs.length; k++) {
    if (used[k]) continue;
    let m = -1;
    for (let j = k + 1; j < runs.length; j++) {
      if (!used[j] && runs[j] === runs[k]) { m = j; break; }
    }
    if (m === -1) { unpaired.add(runs[k]); used[k] = 1; }
    else for (let j = k; j <= m; j++) used[j] = 1;
  }
  return { set: unpaired, total: runs.length };
}

// ------------------------------------------------- node render + emphasis

// Render a delimiter run: normally its closing tags, then the leftover
// literal characters, then its opening tags (innermost last). A closer
// flagged leftoverFirst renders its leftovers before its close tags.
function renderDelim(nd) {
  const left = nd.ch.repeat(nd.len);
  let s = '';
  if (nd.leftoverFirst && nd.closes.length) {
    s += left;
    for (const t of nd.closes) s += '</' + t + '>';
  } else if (nd.closes.length) {
    for (const t of nd.closes) s += '</' + t + '>';
    s += left;
  } else {
    s += left;
  }
  if (nd.opens.length) {
    for (let k = nd.opens.length - 1; k >= 0; k--) s += '<' + nd.opens[k] + '>';
  }
  return s;
}

function renderNodes(nodes, lo, hi) {
  const out = [];
  let i = lo;
  while (i < hi) {
    const nd = nodes[i];
    switch (nd.t) {
      case 'text': out.push(nd.s); i++; break;
      case 'code': out.push('<code>', nd.s, '</code>'); i++; break;
      case 'html': out.push(nd.s); i++; break;
      case 'br': out.push('<br>'); i++; break;
      case 'auto': out.push('<a href="', nd.href, '">', nd.text, '</a>'); i++; break;
      case 'delim': out.push(renderDelim(nd)); i++; break;
      case 'bracket': out.push(nd.image ? '![' : '['); i++; break;
      case 'link':
        out.push('<a href="', nd.href, '"');
        if (nd.title !== null) out.push(' title="', nd.title, '"');
        out.push('>', renderNodes(nodes, nd.cs, nd.ce), '</a>');
        i = nd.ce;
        break;
      case 'image':
        out.push('<img src="', nd.href, '" alt="', altText(nodes, nd.cs, nd.ce), '"');
        if (nd.title !== null) out.push(' title="', nd.title, '"');
        out.push('>');
        i = nd.ce;
        break;
      default: i++; break;
    }
  }
  return out.join('');
}

// Plain-text rendering of a node range, for image alt attributes.
function altText(nodes, lo, hi) {
  let s = '';
  for (let i = lo; i < hi; i++) {
    const nd = nodes[i];
    switch (nd.t) {
      case 'text': case 'code': s += nd.s; break;
      case 'auto': s += nd.text; break;
      case 'delim': s += nd.ch.repeat(nd.len); break;
      case 'bracket': s += nd.image ? '![' : '['; break;
      case 'link': case 'image': s += altText(nodes, nd.cs, nd.ce); i = nd.ce - 1; break;
      default: break;
    }
  }
  return s;
}

function renderInline(text, refs, leak) {
  const n = text.length;
  const nodes = [];
  let buf = '';
  let delimHead = -1, delimTail = -1;
  const openers = [];

  // Leaked anchor state (document-level, threaded in via `leak`): while
  // set, GFM extended autolinks stay plain. An inline `<a ` tag sets it,
  // an inline `</a>` tag clears it; tags inside a formed link's text are
  // pruned at link formation and never affect it.
  let leakOn = leak.on;
  const leakTrans = [];
  const replayLeak = () => {
    leakOn = leak.on;
    for (let k = 0; k < leakTrans.length; k++) leakOn = leakTrans[k].on;
  };

  // Would a link form if ']' appeared at pos? Used to decide whether an
  // autolink tail or a code-span search must stop before a ']'.
  const linkCheck = (pos) => {
    if (openers.length === 0) return false;
    const op = openers[openers.length - 1];
    if (!op.active) return false;
    const res = tryLink(text, pos, op, refs);
    return res !== null && cleanUrl(res.dest) !== null;
  };
  // End index of the link that would form at ']' pos, or -1.
  const linkEndAt = (pos) => {
    if (openers.length === 0) return -1;
    const op = openers[openers.length - 1];
    if (!op.active) return -1;
    const res = tryLink(text, pos, op, refs);
    if (res === null || cleanUrl(res.dest) === null) return -1;
    return res.end;
  };

  const flushBuf = () => {
    if (buf !== '') { nodes.push({ t: 'text', s: buf }); buf = ''; }
  };
  const pushNode = (nd) => { flushBuf(); nodes.push(nd); return nodes.length - 1; };
  // Emphasis suppression: the first formed inline or collapsed link/image
  // whose text holds unpaired backtick runs arms a set of run lengths; a
  // delimiter pairing after it is suppressed when a run of one of those
  // lengths occurs later in the paragraph.
  let firstTrigger = null;
  let runMaxPos = null;
  const getRunMaxPos = () => {
    if (runMaxPos) return runMaxPos;
    runMaxPos = new Map();
    for (let p = 0; p < n;) {
      if (text.charCodeAt(p) === 96) {
        let q = p;
        while (q < n && text.charCodeAt(q) === 96) q++;
        runMaxPos.set(q - p, p);
        p = q;
      } else p++;
    }
    return runMaxPos;
  };
  const isSuppressed = (op, closer) => {
    if (!firstTrigger || firstTrigger.end > op.pos) return false;
    const mp = getRunMaxPos();
    for (const L of firstTrigger.set) {
      const at = mp.get(L);
      if (at !== undefined && at > closer.pos) return true;
    }
    return false;
  };
  const addDelim = (ch, len, canOpen, canClose, pos) => {
    flushBuf();
    const idx = nodes.length;
    nodes.push({
      t: 'delim', ch, len, canOpen, canClose, pos,
      opens: [], closes: [], dp: delimTail, dn: -1, sealed: false, spanOpen: -1,
    });
    if (delimTail !== -1) nodes[delimTail].dn = idx;
    else delimHead = idx;
    delimTail = idx;
    return idx;
  };

  // CommonMark delimiter-stack emphasis resolution, starting after
  // bottomIdx (or from the head when bottomIdx is -1). Per-character
  // bottom barriers, the rule of 3, span jumping, and one marked-specific
  // veto: a single-delimiter span does not pair across a blocking span
  // when that span was strong or the candidate opener is long; the scan
  // continues so a farther opener may still form a strong span. A vetoed
  // closer sets no bottom barrier, so a later strong closer can still
  // reach the opener.
  const processEmphasis = (bottomIdx) => {
    const bottomByChar = new Map();
    let current = bottomIdx === -1 ? delimHead : nodes[bottomIdx].dn;
    while (current !== -1) {
      const closer = nodes[current];
      const next = closer.dn;
      if (closer.t === 'delim' && !closer.sealed && closer.canClose && closer.len > 0) {
        const bottom = bottomByChar.has(closer.ch) ? bottomByChar.get(closer.ch) : bottomIdx;
        let openerIdx = closer.dp;
        let found = -1, oddSkipped = false, blocked = false;
        let hasBarrier = false, barrierUse = 0;
        while (openerIdx !== -1 && openerIdx > bottom) {
          const op = nodes[openerIdx];
          if (op.sealed) { openerIdx = op.dp; continue; }
          // A closer of a formed span that does not match: jump over the
          // whole span — delimiters inside it cannot pair outside it.
          let nextIdx = op.dp;
          if (op.t === 'delim' && op.spanOpen !== -1) nextIdx = op.spanOpen;
          const oddMatch = ((op.len + closer.len) % 3 === 0) &&
            (op.len % 3 !== 0 || closer.len % 3 !== 0);
          if (op.t === 'delim' && op.len > 0 && op.ch === closer.ch && op.canOpen) {
            if (oddMatch && (op.canClose || closer.canOpen)) {
              oddSkipped = true;
              openerIdx = nextIdx;
              continue;
            }
            const useHere = (op.len >= 2 && closer.len >= 2) ? 2 : 1;
            if (hasBarrier && useHere === 1 && (barrierUse >= 2 || op.len >= 2)) {
              blocked = true;
              openerIdx = nextIdx;
              continue;
            }
            found = openerIdx;
            break;
          }
          // Record a span whose opener cannot close and whose closer can
          // open: it may veto pairing across it.
          if (op.t === 'delim' && op.spanOpen !== -1 && op.ch === closer.ch &&
              op.canOpen && !nodes[op.spanOpen].canClose) {
            hasBarrier = true;
            if ((op.lastUse || 0) > barrierUse) barrierUse = op.lastUse;
          }
          openerIdx = nextIdx;
        }
        if (found !== -1) {
          const op = nodes[found];
          if (isSuppressed(op, closer)) {
            op.sealed = true;
            closer.sealed = true;
            current = next;
            continue;
          }
          const use = (op.len >= 2 && closer.len >= 2) ? 2 : 1;
          op.len -= use;
          closer.len -= use;
          const tag = op.ch === '~' ? 'del' : (use === 2 ? 'strong' : 'em');
          op.opens.push(tag);
          closer.closes.push(tag);
          closer.lastUse = use;
          // A strong span formed across a jumped inner span leaves its
          // leftover delimiters inside, before the close tag.
          if (hasBarrier && use === 2) closer.leftoverFirst = true;
          if (closer.spanOpen === -1 || found < closer.spanOpen) closer.spanOpen = found;
          if (closer.len === 0) current = next;
          continue;
        }
        if (!oddSkipped && !blocked) bottomByChar.set(closer.ch, closer.dp);
        current = next;
        continue;
      }
      current = next;
    }
  };

  let i = 0;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === 92) { // backslash
      if (i + 1 < n && text.charCodeAt(i + 1) === 10) {
        flushBuf();
        nodes.push({ t: 'br' });
        i += 2;
        while (i < n && (text.charCodeAt(i) === 32 || text.charCodeAt(i) === 9)) i++;
        continue;
      }
      if (i + 1 < n && isAsciiPunct(text.charCodeAt(i + 1))) {
        buf += escapeHtml(text[i + 1], true);
        i += 2;
        continue;
      }
      buf += '\\';
      i++;
      continue;
    }
    if (c === 96) { // backtick run: code span
      let j = i;
      while (j < n && text.charCodeAt(j) === 96) j++;
      const run = j - i;
      let k = j, found = -1, linkEnd = -1;
      while (k < n) {
        const ck = text.charCodeAt(k);
        if (ck === 96) {
          let m = k;
          while (m < n && text.charCodeAt(m) === 96) m++;
          if (m - k === run) { found = k; break; }
          k = m;
        } else if (ck === 93 && linkEnd === -1) {
          // Remember the first ']' that would form a link: the span wins
          // only when its closer starts at or before the link's end.
          linkEnd = linkEndAt(k);
          k++;
        } else k++;
      }
      if (found !== -1 && linkEnd !== -1 && found > linkEnd) found = -1;
      if (found !== -1) {
        const rawContent = text.slice(j, found);
        let content = rawContent.replace(/\n/g, ' ');
        if (content.length >= 2 && content.charCodeAt(0) === 32 &&
            content.charCodeAt(content.length - 1) === 32 && /[^ ]/.test(content)) {
          content = content.slice(1, -1);
        }
        pushNode({ t: 'code', s: escapeHtml(content, true), run, tick: rawContent.indexOf('`') !== -1 });
        i = found + run;
        continue;
      }
      buf += text.slice(i, j);
      i = j;
      continue;
    }
    if (c === 38) { // &
      const r = decodeNumericRef(text, i);
      if (r) {
        buf += escapeHtml(String.fromCodePoint(r[0]), true);
        i += r[1];
        continue;
      }
      const L = entityLen(text, i);
      if (L > 0) {
        buf += text.slice(i, i + L);
        i += L;
        continue;
      }
      buf += '&amp;';
      i++;
      continue;
    }
    if (c === 60) { // <
      const a = angleAutolink(text, i);
      if (a) {
        const href = cleanUrl(a.dest);
        if (href !== null) {
          pushNode({ t: 'auto', href: escapeHtml(href, false), text: escapeHtml(a.text, true) });
          i += a.len;
          continue;
        }
      }
      const hl = inlineHtmlLen(text, i);
      if (hl > 0) {
        // Anchor leak: `<a ` (literal space after the name) opens,
        // exactly `</a>` closes; both case-insensitive.
        const c1 = text.charCodeAt(i + 1);
        if ((c1 === 97 || c1 === 65) && hl > 2 && text.charCodeAt(i + 2) === 32) {
          leakTrans.push({ pos: i, on: true });
          leakOn = true;
        } else if (hl === 4 && c1 === 47 &&
            (text.charCodeAt(i + 2) === 97 || text.charCodeAt(i + 2) === 65) &&
            text.charCodeAt(i + 3) === 62) {
          leakTrans.push({ pos: i, on: false });
          leakOn = false;
        }
        pushNode({ t: 'html', s: text.slice(i, i + hl) });
        i += hl;
        continue;
      }
      buf += '&lt;';
      i++;
      continue;
    }
    if (c === 62) { buf += '&gt;'; i++; continue; }
    if (c === 34) { buf += '&quot;'; i++; continue; }
    if (c === 39) { buf += '&#39;'; i++; continue; }
    if (c === 10) { // newline: hard break when 2+ spaces trail in buf
      let sp = 0;
      while (sp < buf.length && buf.charCodeAt(buf.length - 1 - sp) === 32) sp++;
      if (sp >= 2) {
        buf = buf.slice(0, buf.length - sp);
        flushBuf();
        nodes.push({ t: 'br' });
        i++;
        while (i < n && (text.charCodeAt(i) === 32 || text.charCodeAt(i) === 9)) i++;
      } else {
        buf += '\n';
        i++;
      }
      continue;
    }
    if (c === 91) { // [
      flushBuf();
      const idx = nodes.length;
      nodes.push({ t: 'bracket', image: false, textStart: i + 1 });
      openers.push({ nodeIdx: idx, image: false, textStart: i + 1, delimTail, active: true });
      i++;
      continue;
    }
    if (c === 33 && i + 1 < n && text.charCodeAt(i + 1) === 91) { // ![
      flushBuf();
      const idx = nodes.length;
      nodes.push({ t: 'bracket', image: true, textStart: i + 2 });
      openers.push({ nodeIdx: idx, image: true, textStart: i + 2, delimTail, active: true });
      i += 2;
      continue;
    }
    if (c === 93) { // ] — only the nearest opener is ever tried
      flushBuf();
      if (openers.length === 0) {
        buf += ']';
        i++;
        continue;
      }
      const op = openers.pop();
      if (!op.active) {
        buf += ']';
        i++;
        continue;
      }
      const res = tryLink(text, i, op, refs);
      const href = res ? cleanUrl(res.dest) : null;
      // A link whose text holds a multi-backtick code span containing a
      // backtick, with more text after the span, never forms: the bracket
      // scan is derailed by the inner backtick. The delimiters inside the
      // span then stay literal too. (A span that ends the link text is
      // fine, as is any single-backtick span.)
      let spanBlocked = false;
      if (res && href !== null) {
        for (let k = op.nodeIdx + 1; k < nodes.length; k++) {
          const nd = nodes[k];
          if (nd.t === 'code' && nd.run >= 2 && nd.tick && k < nodes.length - 1) { spanBlocked = true; break; }
        }
      }
      if (spanBlocked) {
        for (let k = op.nodeIdx + 1; k < nodes.length; k++) {
          if (nodes[k].t === 'delim') nodes[k].sealed = true;
        }
        buf += ']';
        i++;
        continue;
      }
      if (res && href !== null) {
        const nd = nodes[op.nodeIdx];
        nd.t = op.image ? 'image' : 'link';
        nd.href = escapeHtml(href, false);
        nd.title = res.title !== null ? escapeHtml(res.title, false) : null;
        nd.cs = op.nodeIdx + 1;
        nd.ce = nodes.length;
        processEmphasis(op.delimTail);
        // Delimiters inside the link text can never pair with the
        // outside. Extended autolinks inside link text stay plain
        // (angle autolinks still nest): demote them back to text.
        for (let k = op.nodeIdx + 1; k < nd.ce; k++) {
          if (nodes[k].t === 'delim') nodes[k].sealed = true;
          else if (nodes[k].t === 'auto' && nodes[k].ext) { nodes[k].t = 'text'; nodes[k].s = nodes[k].text; }
        }
        // A link opener whose text already holds a link can never link;
        // image openers are unaffected.
        if (!op.image) {
          for (const o of openers) if (!o.image) o.active = false;
        }
        if (!firstTrigger && (res.form === 'inline' || res.form === 'collapsed')) {
          const u = unpairedRunLens(text, op.textStart, i);
          if (u.set.size > 0 && u.total >= 2) firstTrigger = { end: res.end, set: u.set };
        }
        // Anchor-leak transitions from HTML tags inside this link's text
        // never happened: drop them and replay the state.
        if (leakTrans.length > 0) {
          let w = 0;
          for (let k = 0; k < leakTrans.length; k++) {
            if (leakTrans[k].pos < op.textStart || leakTrans[k].pos >= i) leakTrans[w++] = leakTrans[k];
          }
          if (w !== leakTrans.length) {
            leakTrans.length = w;
            replayLeak();
          }
        }
        i = res.end;
      } else {
        buf += ']';
        i++;
      }
      continue;
    }
    if (c === 42 || c === 95 || c === 126) { // * _ ~
      let j = i;
      while (j < n && text.charCodeAt(j) === c) j++;
      const run = j - i;
      if (c === 126 && run >= 3) {
        buf += text.slice(i, j);
        i = j;
        continue;
      }
      const before = charBefore(text, i), after = charAfter(text, j);
      const preSpace = isSpaceCh(before), prePunct = isPunctCh(before);
      const folSpace = isSpaceCh(after), folPunct = isPunctCh(after);
      const left = !folSpace && (!folPunct || preSpace || prePunct);
      const right = !preSpace && (!prePunct || folSpace || folPunct);
      let canOpen, canClose;
      if (c === 95) {
        canOpen = left && (!right || prePunct);
        canClose = right && (!left || folPunct);
      } else {
        canOpen = left;
        canClose = right;
      }
      addDelim(String.fromCharCode(c), run, canOpen, canClose, i);
      i = j;
      continue;
    }
    if (isAlnum(c) && !leakOn && prevCharRule(text, i)) {
      const a = extendedAutolink(text, i, linkCheck);
      if (a) {
        // An email ending right before a '_' run is tentative: it only
        // counts as a link when that run pairs as emphasis (decided
        // after emphasis resolution, below).
        const tent = !!a.email && a.end < n && text.charCodeAt(a.end) === 95;
        pushNode({ t: 'auto', href: a.href, text: a.text, ext: true, tent });
        i = a.end;
        continue;
      }
    }
    buf += text[i];
    i++;
  }
  flushBuf();
  processEmphasis(-1);
  // Resolve tentative emails: the '_' run right after the address is the
  // next node; the address links only when that run paired as emphasis.
  for (let k = 0; k < nodes.length; k++) {
    const nd = nodes[k];
    if (nd.t === 'auto' && nd.tent) {
      const nx = nodes[k + 1];
      if (nx && nx.t === 'delim' && nx.ch === '_' && (nx.opens.length > 0 || nx.closes.length > 0)) continue;
      nd.t = 'text';
      nd.s = nd.text;
    }
  }
  leak.on = leakOn;
  return renderNodes(nodes, 0, nodes.length);
}
