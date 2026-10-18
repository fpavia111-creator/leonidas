'use strict';
/**
 * Minimal, dependency-free YAML subset reader/writer for Leonidas of the Web config files.
 * Supports: block maps, block lists (of scalars or maps), plain / 'single' / "double"
 * quoted scalars (incl. multi-line folded), quoted keys, comments, numbers, booleans, null.
 * Not supported (throws): anchors/aliases, tags, flow collections other than [] / {},
 * block scalars (| and >). Duplicate keys are allowed (last wins) but reported.
 */

class YamlError extends Error {}

function stripComment(s) {
  // remove " # comment" outside quotes
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === q) { if (q === "'" && s[i + 1] === "'") { i++; continue; } q = null; } else if (q === '"' && c === '\\') i++; continue; }
    if (c === '"' || c === "'") { if (i === 0 || /[\s:\-\[{,]/.test(s[i - 1])) q = c; continue; }
    if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i).replace(/\s+$/, '');
  }
  return s.replace(/\s+$/, '');
}

function scalar(raw, lineNo) {
  const s = raw.trim();
  if (s === '' || s === '~' || s === 'null') return s === '' ? null : null;
  if (s === '[]') return [];
  if (s === '{}') return {};
  if (s[0] === "'") {
    if (!s.endsWith("'") || s.length < 2) throw new YamlError(`line ${lineNo}: unterminated single-quoted string`);
    return s.slice(1, -1).replace(/''/g, "'");
  }
  if (s[0] === '"') {
    try { return JSON.parse(s.replace(/\\\//g, '/')); } catch { throw new YamlError(`line ${lineNo}: bad double-quoted string`); }
  }
  if (/^[&*!|>]/.test(s) || /^[\[{]/.test(s)) throw new YamlError(`line ${lineNo}: unsupported YAML syntax "${s.slice(0, 20)}"`);
  if (s === 'true' || s === 'True') return true;
  if (s === 'false' || s === 'False') return false;
  if (/^[-+]?\d+$/.test(s)) return Number(s);
  if (/^[-+]?(\d+\.\d*|\.\d+)([eE][-+]?\d+)?$/.test(s)) return Number(s);
  return s;
}

/** Split "key: value" respecting a quoted key. Returns null if not a mapping line. */
function splitKey(t) {
  if (t[0] === '"' || t[0] === "'") {
    const q = t[0];
    let i = 1;
    for (; i < t.length; i++) { if (t[i] === '\\' && q === '"') { i++; continue; } if (t[i] === q) { if (q === "'" && t[i + 1] === "'") { i++; continue; } break; } }
    if (i >= t.length) return null;
    const rest = t.slice(i + 1);
    if (!/^\s*:(\s|$)/.test(rest)) return null;
    const key = scalar(t.slice(0, i + 1));
    return { key: String(key), value: rest.replace(/^\s*:/, '') };
  }
  const m = t.match(/^([^\s:#'"][^:#]*?)\s*:(\s+|$)(.*)$/);
  if (!m) return null;
  return { key: m[1], value: m[3] };
}

function parse(text) {
  const warnings = [];
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n').map((raw, i) => {
    const noTab = raw.replace(/^\t+/, m => { throw new YamlError(`line ${i + 1}: tabs are not allowed for indentation`); });
    return { n: i + 1, indent: noTab.match(/^ */)[0].length, text: noTab.trim() === '' || noTab.trim().startsWith('#') ? '' : stripComment(noTab).trim(), raw: noTab };
  }).filter(l => l.text !== '' && l.text !== '---');
  let pos = 0;

  // read a scalar value that starts on `first` and may continue on lines indented > baseIndent
  function readScalar(first, baseIndent, lineNo) {
    let s = first.trim();
    const q = s[0];
    const closed = str => {
      if (str.length < 2 || str[str.length - 1] !== q) return false;
      if (q === "'") { const m = str.slice(1).match(/'*$/)[0].length; return m % 2 === 1; }
      let bs = 0; for (let i = str.length - 2; str[i] === '\\'; i--) bs++; return bs % 2 === 0;
    };
    if (q === "'" || q === '"') {
      while (!closed(s)) {
        if (pos >= lines.length) throw new YamlError(`line ${lineNo}: unterminated quoted string`);
        s += ' ' + lines[pos].raw.trim(); pos++;
      }
      return scalar(s, lineNo);
    }
    while (pos < lines.length && lines[pos].indent > baseIndent && s !== '' && !lines[pos].text.startsWith('- ') ) {
      s += ' ' + lines[pos].text; pos++;
    }
    return scalar(s, lineNo);
  }

  function parseBlock(indent, path) {
    const l = lines[pos];
    if (l.text.startsWith('- ') || l.text === '-') return parseList(l.indent, path);
    return parseMap(l.indent, path);
  }

  function parseList(indent, path) {
    const out = [];
    while (pos < lines.length && lines[pos].indent === indent && (lines[pos].text.startsWith('- ') || lines[pos].text === '-')) {
      const l = lines[pos]; pos++;
      const rest = l.text === '-' ? '' : l.text.slice(2);
      if (rest === '') {
        if (pos < lines.length && lines[pos].indent > indent) out.push(parseBlock(lines[pos].indent, path + '[]')); else out.push(null);
        continue;
      }
      const kv = splitKey(rest);
      if (kv) {
        // list item that is a map: treat "- key: v" as a map at indent+2
        const itemIndent = indent + 2;
        lines.splice(pos, 0, { n: l.n, indent: itemIndent, text: rest, raw: ' '.repeat(itemIndent) + rest });
        out.push(parseMap(itemIndent, path + '[]'));
      } else out.push(readScalar(rest, indent, l.n));
    }
    return out;
  }

  function parseMap(indent, path) {
    const out = {};
    while (pos < lines.length && lines[pos].indent === indent) {
      const l = lines[pos];
      if (l.text.startsWith('- ')) break;
      const kv = splitKey(l.text);
      if (!kv) throw new YamlError(`line ${l.n}: expected "key: value", got "${l.text.slice(0, 40)}"`);
      pos++;
      const full = path ? `${path}.${kv.key}` : kv.key;
      if (Object.prototype.hasOwnProperty.call(out, kv.key)) warnings.push({ line: l.n, key: full, message: `duplicate key "${full}" (last value wins)` });
      let val;
      if (kv.value.trim() === '') {
        if (pos < lines.length && (lines[pos].indent > indent || (lines[pos].indent === indent && lines[pos].text.startsWith('- ')))) val = parseBlock(lines[pos].indent, full);
        else val = null;
      } else val = readScalar(kv.value, indent, l.n);
      out[kv.key] = val;
    }
    return out;
  }

  if (!lines.length) return { value: {}, warnings };
  const value = parseBlock(lines[0].indent, '');
  if (pos < lines.length) throw new YamlError(`line ${lines[pos].n}: unexpected indentation`);
  return { value, warnings };
}

const PLAIN_OK = /^[A-Za-z0-9_./@+-][A-Za-z0-9 _./@+()-]*$/;
function fmtScalar(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  const s = String(v);
  if (s !== '' && PLAIN_OK.test(s) && !/^(true|false|null|~|[-+]?\d[\d.eE+-]*)$/i.test(s) && !/\s$/.test(s) && !/^- /.test(s)) return s;
  return JSON.stringify(s);
}
function fmtKey(k) { return /^[A-Za-z_][A-Za-z0-9_-]*$/.test(k) ? k : JSON.stringify(k); }

function stringify(v, indent = 0) {
  const pad = ' '.repeat(indent);
  if (Array.isArray(v)) {
    if (!v.length) return '[]';
    return v.map(x => (x && typeof x === 'object' && !Array.isArray(x) && Object.keys(x).length)
      ? `${pad}- ` + stringify(x, indent + 2).slice(indent + 2)
      : `${pad}- ${x && typeof x === 'object' ? stringify(x, indent + 2) : fmtScalar(x)}`).join('\n');
  }
  if (v && typeof v === 'object') {
    const keys = Object.keys(v);
    if (!keys.length) return '{}';
    return keys.map(k => {
      const x = v[k];
      if (x && typeof x === 'object' && (Array.isArray(x) ? x.length : Object.keys(x).length)) return `${pad}${fmtKey(k)}:\n${stringify(x, indent + 2)}`;
      return `${pad}${fmtKey(k)}: ${x && typeof x === 'object' ? (Array.isArray(x) ? '[]' : '{}') : fmtScalar(x)}`;
    }).join('\n');
  }
  return fmtScalar(v);
}

module.exports = { parse, stringify: v => stringify(v) + '\n', YamlError };
