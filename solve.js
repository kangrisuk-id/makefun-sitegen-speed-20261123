// Fast drop-in replacement for makefun-site 1.0.0.
//
// run(input) returns, byte for byte, the output tree that makefun-site 1.0.0's
// build returns for the same input: every page's index.html, the index and tag
// pages, build-report.txt and each static file. The dialect (front matter,
// templates, Markdown subset, slug rule, report) is makefun-site's own; this
// module re-implements it with single-pass scanners instead of per-line and
// per-character regular expressions, per-case memoisation of pure text
// functions (slugify, long dates, resolved link paths), a fused Markdown
// lexer/renderer that classifies each line once and renders inline markup on
// index ranges of the original string, and templates compiled once per case
// into plain functions (with the tree-walking interpreter kept as a fallback
// when dynamic compilation is unavailable). Nothing is cached across cases:
// every run() call builds all of its tables from scratch.

// ---------------------------------------------------------------- text rules

const ESC_ENTITY = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** `text` with & < > " and ' escaped; returns the input untouched when there is nothing to escape. Plain stretches are copied as slices, never per character. */
function esc(text) {
  let out = '';
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 38 || c === 60 || c === 62 || c === 34 || c === 39) {
      out += text.slice(start, i) + ESC_ENTITY[text[i]];
      start = i + 1;
    }
  }
  if (start === 0) return text;
  return start < text.length ? out + text.slice(start) : out;
}

const SLUG_MAX = 64;
const SLUG_READY_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The slug of `text`, exactly makefun-site's rule, with a fast ASCII path (NFKD is the identity on ASCII). */
function slugifyRaw(text) {
  // already a slug of at most the max length: the rule below returns it as-is
  if (text.length <= SLUG_MAX && SLUG_READY_RE.test(text)) return text;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) >= 128) { ascii = false; break; }
  }
  let out = '';
  let gap = false;
  if (ascii) {
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      let keep = -1;
      if (c >= 65 && c <= 90) keep = c + 32;
      else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
      if (keep === -1) { gap = out.length > 0; continue; }
      if (gap) out += '-';
      gap = false;
      out += String.fromCharCode(keep);
    }
  } else {
    const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
    for (const ch of plain) {
      let keep = null;
      if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
      else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
      if (keep === null) { gap = out.length > 0; continue; }
      if (gap) out += '-';
      gap = false;
      out += keep;
    }
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/** slugify memoised in a per-case Map (slugify is a pure function of its text). */
function slugify(cache, text) {
  let v = cache.get(text);
  if (v === undefined) { v = slugifyRaw(text); cache.set(text, v); }
  return v;
}

/** `slug` made unique against `taken` (and added to it): slug, slug-2, slug-3, ... */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. */
function longDateRaw(date) {
  const dash1 = date.indexOf('-');
  const dash2 = date.indexOf('-', dash1 + 1);
  const y = date.slice(0, dash1);
  const m = Number(date.slice(dash1 + 1, dash2));
  const d = Number(date.slice(dash2 + 1));
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

function longDate(cache, date) {
  let v = cache.get(date);
  if (v === undefined) { v = longDateRaw(date); cache.set(date, v); }
  return v;
}

/** The number of words in `text`: its runs of characters other than whitespace (the JS \s set). */
function wordsOf(text) {
  let count = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    let ws;
    if (c <= 32) ws = c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 11;
    else if (c < 128) ws = false;
    else ws = c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
    if (ws) inWord = false;
    else if (!inWord) { inWord = true; count++; }
  }
  return count;
}

// ---------------------------------------------------------------- front matter

const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME_RE = /^[a-z0-9-]+$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare (never opening on " or [). */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) { // "
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE_RE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (const t of tags) {
        if (t === '' || t.includes('"') || t.includes('[') || t.includes(']')) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME_RE.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG_RE.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first
 * reason it is refused. `text` has "\n" line ends. Only the front-matter lines
 * are materialised; the body is the untouched remainder of the text.
 */
function parseFrontMatter(text) {
  const firstNl = text.indexOf('\n');
  const firstLine = firstNl === -1 ? text : text.slice(0, firstNl);
  if (firstLine !== '---') return { error: 'no front matter' };
  if (firstNl === -1) return { error: 'the front matter is not closed' };
  const fmLines = [];
  let closeEnd = -2; // index of the "\n" ending the closing line, -1 when it ends the text
  let pos = firstNl + 1;
  for (;;) {
    const end = text.indexOf('\n', pos);
    const line = end === -1 ? text.slice(pos) : text.slice(pos, end);
    if (line === '---') { closeEnd = end; break; }
    fmLines.push(line);
    if (end === -1) break;
    pos = end + 1;
  }
  if (closeEnd === -2) return { error: 'the front matter is not closed' };
  const data = {};
  for (let k = 0; k < fmLines.length; k++) {
    const line = fmLines[k];
    if (isBlankLine(line) || line.startsWith('#')) continue;
    // /^([a-z_]+):(?: (.*))?$/ by hand
    let ki = 0;
    while (ki < line.length) {
      const c = line.charCodeAt(ki);
      if ((c >= 97 && c <= 122) || c === 95) ki++;
      else break;
    }
    if (ki === 0 || line[ki] !== ':') return { error: `line ${k + 2} is not "key: value"` };
    const rest = line.slice(ki + 1);
    let raw;
    if (rest === '') raw = '';
    else if (rest.charCodeAt(0) === 32) raw = rest.slice(1);
    else return { error: `line ${k + 2} is not "key: value"` };
    const key = line.slice(0, ki);
    // drop trailing spaces and tabs from the value
    let re = raw.length;
    while (re > 0 && (raw.charCodeAt(re - 1) === 32 || raw.charCodeAt(re - 1) === 9)) re--;
    if (re !== raw.length) raw = raw.slice(0, re);
    if (!FM_KEYS.has(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: closeEnd === -1 ? '' : text.slice(closeEnd + 1) };
}

// ---------------------------------------------------------------- templates

const INCLUDE_DEPTH = 8;
const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

class TemplateError extends Error {}

function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

function isSpaceTabOnly(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = isSpaceTabOnly(src.slice(lineStart, open)) && isSpaceTabOnly(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let s = scope;
  const head = path[0];
  while (s !== null && !Object.hasOwn(s.vars, head)) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[head];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** `nodes` rendered in `scope`, appending into `out` (an array of strings). */
function renderNodes(nodes, scope, ctx, depth, out) {
  for (let idx = 0; idx < nodes.length; idx++) {
    const n = nodes[idx];
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var':
        out.push(esc(textOf(lookup(scope, n.path))));
        break;
      case 'raw':
        out.push(textOf(lookup(scope, n.path)));
        break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, scope, ctx, depth, out);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        const len = xs.length;
        for (let k = 0; k < len; k++) {
          const vars = { [n.name]: xs[k], loop: { index: k + 1, first: k === 0, last: k === len - 1, length: len } };
          renderNodes(n.body, { vars, parent: scope }, ctx, depth, out);
        }
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) renderNodes(t, scope, ctx, depth + 1, out);
        break;
      }
    }
  }
}

// ------------------------------------------------------- compiled templates

// The interpreter above walks the node tree for every render. The compiled
// form below turns each template's tree, once per case, into a plain JS
// function: text becomes string literals, paths become scope-stack lookups,
// loops become JS loops, and the output accumulates in one string. The
// semantics are the interpreter's, node for node; if dynamic compilation is
// unavailable the interpreter is used instead, unchanged.

const HAS_OWN = Object.hasOwn;

/** The value of `head` from the nearest scope-stack level holding it, else undefined. */
function lkHead(stack, head) {
  for (let i = stack.length - 1; i >= 0; i--) {
    const vars = stack[i];
    if (HAS_OWN(vars, head)) return vars[head];
  }
  return undefined;
}

/** One step of a path walk: an object's own property, else undefined. */
function lkProp(v, key) {
  return v !== null && typeof v === 'object' && HAS_OWN(v, key) ? v[key] : undefined;
}

/** A path as a lookup expression against the generated function's scope stack. */
function pathExpr(path) {
  let e = `lkH(S, ${JSON.stringify(path[0])})`;
  for (let k = 1; k < path.length; k++) e = `lkP(${e}, ${JSON.stringify(path[k])})`;
  return e;
}

/** The generated code for a node list, appending into the function's `O`. */
function genNodes(nodes) {
  let code = '';
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        code += `O += ${JSON.stringify(n.text)};`;
        break;
      case 'var':
        code += `O += escF(txtF(${pathExpr(n.path)}));`;
        break;
      case 'raw':
        code += `O += txtF(${pathExpr(n.path)});`;
        break;
      case 'if': {
        const cond = `truF(${pathExpr(n.path)}) !== ${n.not}`;
        code += n.else !== null
          ? `if (${cond}) {${genNodes(n.then)}} else {${genNodes(n.else)}}`
          : `if (${cond}) {${genNodes(n.then)}}`;
        break;
      }
      case 'for':
        // one vars object and one loop object per loop entry, mutated per
        // iteration; the name is set before `loop` each round, exactly as
        // the interpreter's per-iteration object literal orders them
        code += `{ const xs = ${pathExpr(n.path)}; if (Array.isArray(xs)) { const len = xs.length; const vs = {}; const lp = { index: 0, first: false, last: false, length: len }; S.push(vs); for (let k = 0; k < len; k++) { vs[${JSON.stringify(n.name)}] = xs[k]; vs.loop = lp; lp.index = k + 1; lp.first = k === 0; lp.last = k === len - 1; ${genNodes(n.body)} } S.pop(); } }`;
        break;
      case 'include':
        code += `if (D < ${INCLUDE_DEPTH}) { const f = C.t.get(${JSON.stringify(n.name)}); if (f !== undefined) O += f(S, C, D + 1, lkH, lkP, escF, txtF, truF); }`;
        break;
    }
  }
  return code;
}

/** `nodes` compiled into a render function (S, C, D, helpers...) -> string. */
function compileTemplate(nodes) {
  return new Function('S', 'C', 'D', 'lkH', 'lkP', 'escF', 'txtF', 'truF', `let O = ''; ${genNodes(nodes)} return O;`);
}

// ---------------------------------------------------------------- markdown

const ESCAPABLE = '\\`*_[]()#+-.!>';

function isEscapable(ch) {
  return ESCAPABLE.indexOf(ch) !== -1;
}

/** The first index from `from` where `s` holds `what` before `hi`, outside a backslash escape, or -1. */
function findUnescaped(s, what, from, hi) {
  const last = hi - what.length;
  for (let j = from; j <= last; j++) {
    if (s[j] === '\\' && j + 1 < hi && isEscapable(s[j + 1])) { j++; continue; }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` and before `hi` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from, hi) {
  for (let j = from; j < hi; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < hi && isEscapable(s[j + 1])) { j++; continue; }
    if (c !== '*') continue;
    if (j + 1 < hi && s[j + 1] === '*') { j++; continue; }
    return j;
  }
  return -1;
}

const WS_RE = /\s/;
const MARK_RE = /[\\`*\[&<>"']/g;

/** `s` rendered inline; `link(target)` resolves a link's href. Plain runs are copied without per-char work. */
function inline(s, link) {
  return inlineRange(s, 0, s.length, link);
}

/**
 * The range s[lo..hi) rendered inline, on the original string: nested
 * segments (strong, em, link text) recurse on sub-ranges instead of slicing
 * a copy of the segment first. `hi` acts exactly as the substring's end did.
 */
function inlineRange(s, lo, hi, link) {
  let out = '';
  let i = lo;
  while (i < hi) {
    const code = s.charCodeAt(i);
    // plain run: everything up to the next mark starter or escape-needing
    // char, located with a native regex scan rather than a per-char loop
    if (code !== 92 && code !== 96 && code !== 42 && code !== 91 && code !== 38 && code !== 60 && code !== 62 && code !== 34 && code !== 39) {
      MARK_RE.lastIndex = i;
      const m = MARK_RE.exec(s);
      const end = m === null || m.index > hi ? hi : m.index;
      out += s.slice(i, end);
      i = end;
      continue;
    }
    const c = s[i];
    if (c === '\\') {
      if (i + 1 < hi && isEscapable(s[i + 1])) {
        const n = s[i + 1];
        out += n === '>' ? '&gt;' : n;
        i += 2;
      } else {
        out += '\\';
        i++;
      }
      continue;
    }
    if (c === '`') {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1 && j < hi) {
        out += '<code>' + esc(s.slice(i + 1, j)) + '</code>';
        i = j + 1;
      } else {
        out += '`';
        i++;
      }
      continue;
    }
    if (c === '*') {
      if (i + 1 < hi && s[i + 1] === '*') {
        const j = findUnescaped(s, '**', i + 2, hi);
        if (j > i + 2) {
          out += '<strong>' + inlineRange(s, i + 2, j, link) + '</strong>';
          i = j + 2;
        } else {
          out += '**';
          i += 2;
        }
        continue;
      }
      const j = findSingleStar(s, i + 1, hi);
      if (j > i + 1) {
        out += '<em>' + inlineRange(s, i + 1, j, link) + '</em>';
        i = j + 1;
      } else {
        out += '*';
        i++;
      }
      continue;
    }
    if (c === '[') {
      const k = findUnescaped(s, ']', i + 1, hi);
      const m = k !== -1 && k + 1 < hi && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = m === -1 || m >= hi ? '' : s.slice(k + 2, m);
      if (target !== '' && !WS_RE.test(target)) {
        out += '<a href="' + esc(link(target)) + '">' + inlineRange(s, i + 1, k, link) + '</a>';
        i = m + 1;
        continue;
      }
      out += '[';
      i++;
      continue;
    }
    // & < > " '
    out += ESC_ENTITY[c];
    i++;
  }
  return out;
}

// --- block-level line classification, by hand (no per-line regexes)

function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b) { const c = line.charCodeAt(a); if (c === 32 || c === 9) a++; else break; }
  while (b > a) { const c = line.charCodeAt(b - 1); if (c === 32 || c === 9) b--; else break; }
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** A fence-opening line's language, or null: three backticks, language chars, then spaces/tabs only. */
function fenceLang(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  const start = i;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  const lang = line.slice(start, i);
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c === 32 || c === 9) i++;
    else return null;
  }
  return lang;
}

function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's {depth, text}, or null. */
function headingOf(line) {
  let n = 0;
  while (n < line.length && line.charCodeAt(n) === 35) n++;
  if (n === 0 || n > 6) return null;
  if (n >= line.length) return null;
  const sep = line.charCodeAt(n);
  if (sep !== 32 && sep !== 9) return null;
  let a = n;
  while (a < line.length) { const c = line.charCodeAt(a); if (c === 32 || c === 9) a++; else break; }
  let b = line.length;
  while (b > a) { const c = line.charCodeAt(b - 1); if (c === 32 || c === 9) b--; else break; }
  if (b <= a) return null;
  return { depth: n, text: line.slice(a, b) };
}

function isHR(line) {
  const a = line.charCodeAt(0);
  const b = line.charCodeAt(1);
  const c = line.charCodeAt(2);
  if (!((a === 45 && b === 45 && c === 45) || (a === 42 && b === 42 && c === 42))) return false;
  for (let i = 3; i < line.length; i++) {
    const ch = line.charCodeAt(i);
    if (ch !== 32 && ch !== 9) return false;
  }
  return true;
}

/**
 * One pass over a line's head decides its block kind and payload, in the same
 * order the reference's separate tests run: blank, fence, heading, rule,
 * quote, bullet, ordered, else paragraph text. The result fills a shared
 * scratch object (renderMarkdown is never re-entered), so classifying a line
 * costs no allocation and the paragraph test reuses the same verdict.
 */
const CLS = { kind: 'para', lang: '', depth: 0, text: '', num: 0 };
function classifyLine(line) {
  const c0 = line.charCodeAt(0);
  if (line.length === 0 || c0 === 32 || c0 === 9) {
    for (let i = 0; i < line.length; i++) {
      const c = line.charCodeAt(i);
      if (c !== 32 && c !== 9) { CLS.kind = 'para'; return CLS; }
    }
    CLS.kind = 'blank';
    return CLS;
  }
  if (c0 === 96) { // `
    const lang = fenceLang(line);
    if (lang !== null) { CLS.kind = 'fence'; CLS.lang = lang; return CLS; }
    CLS.kind = 'para';
    return CLS;
  }
  if (c0 === 35) { // #
    const h = headingOf(line);
    if (h !== null) { CLS.kind = 'heading'; CLS.depth = h.depth; CLS.text = h.text; return CLS; }
    CLS.kind = 'para';
    return CLS;
  }
  if (c0 === 45 || c0 === 42) { // - or *
    if (isHR(line)) { CLS.kind = 'hr'; return CLS; }
    const t = bulletText(line);
    if (t !== null) { CLS.kind = 'bullet'; CLS.text = t; return CLS; }
    CLS.kind = 'para';
    return CLS;
  }
  if (c0 === 62) { CLS.kind = 'quote'; return CLS; } // >
  if (c0 >= 48 && c0 <= 57) { // digit
    const o = orderedItem(line);
    if (o !== null) { CLS.kind = 'ordered'; CLS.num = o.num; CLS.text = o.text; return CLS; }
  }
  CLS.kind = 'para';
  return CLS;
}

/** Whether a classified line ends a paragraph: blank, fence, heading or rule. */
function clsEndsParagraph(kind) {
  return kind === 'blank' || kind === 'fence' || kind === 'heading' || kind === 'hr';
}

/** A bullet item's text or null: "- " or "* " then the rest. */
function bulletText(line) {
  const c = line.charCodeAt(0);
  if ((c === 45 || c === 42) && line.charCodeAt(1) === 32) return line.slice(2);
  return null;
}

/** An ordered item {num, text} or null: 1-9 digits, ". ", then the rest. */
function orderedItem(line) {
  let n = 0;
  while (n < line.length) {
    const c = line.charCodeAt(n);
    if (c >= 48 && c <= 57) n++;
    else break;
  }
  if (n === 0 || n > 9) return null;
  if (line.charCodeAt(n) !== 46 || line.charCodeAt(n + 1) !== 32) return null;
  return { num: Number(line.slice(0, n)), text: line.slice(n + 2) };
}

function isContinued(line) {
  let n = 0;
  while (n < line.length && line.charCodeAt(n) === 32) n++;
  if (n < 2 || n >= line.length) return false;
  return !WS_RE.test(line[n]);
}

/**
 * `src` rendered: its HTML (a "\n" after each block), its table of contents
 * (level 2 and 3 headings) and its excerpt (the first paragraph's HTML, or "").
 * Lexing and rendering are fused into one pass over the lines.
 */
function renderMarkdown(src, link, slugCache) {
  const lines = src.split('\n');
  const ids = new Set();
  const parts = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const cls = classifyLine(line);
    const kind = cls.kind;
    if (kind === 'blank') { i++; continue; }
    if (kind === 'fence') {
      const lang = cls.lang;
      i++;
      const clsAttr = lang === '' ? '' : ` class="language-${esc(lang)}"`;
      parts.push(`<pre><code${clsAttr}>`);
      while (i < lines.length && !isFenceClose(lines[i])) { parts.push(esc(lines[i]), '\n'); i++; }
      i++;
      parts.push('</code></pre>', '\n');
      continue;
    }
    if (kind === 'heading') {
      const depth = cls.depth;
      const text = cls.text;
      const id = uniqueSlug(slugify(slugCache, text), ids);
      const html = inline(text, link);
      parts.push(`<h${depth} id="${id}">${html}</h${depth}>`, '\n');
      if (depth === 2 || depth === 3) toc.push({ level: depth, id, html });
      i++;
      continue;
    }
    if (kind === 'hr') { parts.push('<hr>', '\n'); i++; continue; }
    if (kind === 'quote') { // >
      const kept = [];
      while (i < lines.length && lines[i].charCodeAt(0) === 62) {
        let l = lines[i].slice(1);
        if (l.charCodeAt(0) === 32) l = l.slice(1);
        l = trimLine(l);
        if (l !== '') kept.push(l);
        i++;
      }
      parts.push(kept.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inline(kept.join('\n'), link)}</p>\n</blockquote>`, '\n');
      continue;
    }
    if (kind === 'bullet' || kind === 'ordered') {
      const isOrdered = kind === 'ordered';
      const firstNum = cls.num;
      const items = [];
      while (i < lines.length) {
        const l = lines[i];
        if (isOrdered) {
          const m = orderedItem(l);
          if (m === null) {
            if (isContinued(l) && items.length > 0) { items[items.length - 1].push(trimLine(l)); i++; continue; }
            break;
          }
          items.push([trimLine(m.text)]);
          i++;
        } else {
          const t = bulletText(l);
          if (t === null) {
            if (isContinued(l) && items.length > 0) { items[items.length - 1].push(trimLine(l)); i++; continue; }
            break;
          }
          items.push([trimLine(t)]);
          i++;
        }
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && firstNum !== 1 ? `<ol start="${firstNum}">` : `<${tag}>`;
      parts.push(open + '\n');
      for (const partsOfItem of items) parts.push(`<li>${inline(partsOfItem.join('\n'), link)}</li>\n`);
      parts.push(`</${tag}>`, '\n');
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < lines.length && !clsEndsParagraph(classifyLine(lines[i]).kind)) { body.push(trimLine(lines[i])); i++; }
    const html = inline(body.join('\n'), link);
    if (excerpt === null) excerpt = html;
    parts.push(`<p>${html}</p>`, '\n');
  }
  return { html: parts.join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- the build

const RESERVED = ['posts', 'tags', 'page'];
const REPORT_FILE = 'build-report.txt';

function byCodeUnits(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function dirOf(path) {
  const at = path.lastIndexOf('/');
  return at === -1 ? '' : path.slice(0, at);
}

/** `rel` from directory `dir`, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  const segs = rel.split('/');
  for (let k = 0; k < segs.length; k++) {
    const seg = segs[k];
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/** `rel` from directory `dir`, memoised in a per-case nested Map, or null when it climbs out of the root. */
function resolveCached(cache, dir, rel) {
  let byRel = cache.get(dir);
  if (byRel === undefined) { byRel = new Map(); cache.set(dir, byRel); }
  let v = byRel.get(rel);
  if (v === undefined) {
    v = resolvePath(dir, rel);
    byRel.set(rel, v);
  }
  return v;
}

function hasScheme(target) {
  const c0 = target.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  let i = 1;
  while (i < target.length) {
    const c = target.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 46 || c === 45) i++;
    else break;
  }
  return target.charCodeAt(i) === 58; // :
}

/** One site's output tree: path -> text, exactly as makefun-site 1.0.0 builds it. */
export function run(input) {
  const slugCache = new Map();
  const dateCache = new Map();
  const report = [];
  const templates = new Map();
  const names = Object.keys(input.templates).sort(byCodeUnits);
  for (const name of names) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  let base = input.site.base_url;
  while (base.endsWith('/')) base = base.slice(0, -1);

  // the same templates compiled to functions, when dynamic compilation is
  // available; otherwise `compiled` stays null and renders use the interpreter
  let compiled = null;
  try {
    const m = new Map();
    for (const [name, nodes] of templates) m.set(name, compileTemplate(nodes));
    compiled = m;
  } catch {
    compiled = null;
  }

  // 1. sources in code-unit order of path; .md is a source, anything else static
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  let sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const rawText = f.content;
      sources.push({ path: f.path, text: rawText.indexOf('\r') === -1 ? rawText : rawText.replace(/\r\n?/g, '\n') });
    } else statics.push({ path: f.path, content: f.content });
  }

  // 2. front matter and the refusal/draft checks, in the reference's order
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) { report.push(`refused ${s.path}: ${fm.error}`); continue; }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own;
    if (s.path.startsWith('tags/')) own = 'tags';
    else if (s.path.startsWith('page/')) own = 'page';
    if (own !== undefined) { report.push(`refused ${s.path}: ${own}/ is the generator's own`); continue; }
    if (s.post && !Object.hasOwn(s.data, 'date')) { report.push(`refused ${s.path}: a post needs a date`); continue; }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) { report.push(`refused ${s.path}: layout "${layout}" is no template that parses`); continue; }
    s.layout = layout;
    if (s.data.draft === true) { report.push(`draft ${s.path}`); continue; }
    kept.push(s);
  }
  sources = kept;

  // 3. permalinks: slug unique in its directory, in source order
  const taken = new Map();
  const bySource = new Map();
  for (const s of sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) { set = new Set(dir === '' ? RESERVED : []); taken.set(dir, set); }
    const slug = uniqueSlug(s.data.slug ?? slugify(slugCache, s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. markdown, links resolved
  const staticPaths = new Set();
  for (const f of statics) staticPaths.add(f.path);
  const pathCache = new Map();
  const broken = new Set();
  for (const s of sources) {
    const dir = dirOf(s.path);
    const srcPath = s.path;
    const link = (target) => {
      if (hasScheme(target) || target.startsWith('/') || target.startsWith('#')) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolveCached(pathCache, dir, rel);
      if (path !== null) {
        const page = bySource.get(path);
        if (page !== undefined) return `${page.url}${frag}`;
        if (staticPaths.has(path)) return `${base}/${path}${frag}`;
      }
      broken.add(`broken-link ${srcPath} -> ${target}`);
      return target;
    };
    const md = renderMarkdown(s.body, link, slugCache);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. collections: posts newest first, equal dates by slug
  const posts = sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  const linkOf = (s) => (s === null ? null : {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(dateCache, s.data.date),
  });
  for (let k = 0; k < posts.length; k++) {
    posts[k].newerLink = linkOf(k === 0 ? null : posts[k - 1]);
    posts[k].olderLink = linkOf(k === posts.length - 1 ? null : posts[k + 1]);
  }

  // 6. tags, grouped by slug, named as first met in collection order
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    const list = s.data.tags ?? [];
    for (const name of list) {
      const slug = slugify(slugCache, name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      out.push(name);
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(slugCache, name);
      let tag = bySlug.get(slug);
      if (tag === undefined) { tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] }; bySlug.set(slug, tag); }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of sources) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => {
      const slug = slugify(slugCache, name);
      return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
    });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // cards for every source (templates read pages and posts through them)
  for (const s of sources) {
    s.card = {
      title: s.data.title,
      url: s.url,
      date: s.data.date ?? '',
      date_long: s.data.date === undefined ? '' : longDate(dateCache, s.data.date),
      summary: s.data.summary ?? '',
      excerpt: s.excerpt,
      reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
      tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
    };
  }
  const postCards = posts.map((p) => p.card);

  // 7. layouts: pages, index pages, tag pages, the tags index, then statics
  const output = {};
  const siteObj = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = postCards.slice(0, input.site.recent);
  const tctx = { templates };
  const cctx = compiled === null ? null : { t: compiled };
  const baseVars = { site: siteObj, tags: allTags, recent };
  const render = (name, vars) => {
    if (compiled !== null) {
      const fn = compiled.get(name);
      if (fn === undefined) return null;
      return fn([baseVars, vars], cctx, 0, lkHead, lkProp, esc, textOf, truthy);
    }
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const scope = { vars: { site: siteObj, tags: allTags, recent, ...vars }, parent: null };
    const out = [];
    renderNodes(nodes, scope, tctx, 0, out);
    return out.join('');
  };
  for (const s of sources) {
    const page = {
      ...s.card,
      slug: s.slug,
      content: s.html,
      toc: s.toc,
      newer: s.newerLink ?? null,
      older: s.olderLink ?? null,
      is_post: s.post,
    };
    output[`${s.outDir}/index.html`] = render(s.layout, { page });
  }
  const per = input.site.per_page;
  const pageCount = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pageCount; k++) {
    const html = render('index', {
      posts: postCards.slice((k - 1) * per, k * per),
      pager: { number: k, total: pageCount, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pageCount ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const tagObj = { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => p.card) };
    const html = render('tag', { tag: tagObj });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. the report
  const lines = [...report, ...broken].sort(byCodeUnits);
  let pageTotal = 0;
  for (const s of sources) if (!s.post) pageTotal++;
  lines.push(`built ${pageTotal} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}
