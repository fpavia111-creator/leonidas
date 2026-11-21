'use strict';
/**
 * Minimal read-only IMAP client on Node's built-in tls (no dependencies).
 * Works with Gmail (imap.gmail.com:993, app password) and cPanel mailboxes (mail.<domain>:993).
 * Implicit TLS only (port 993). The mailbox is opened with EXAMINE and bodies are fetched with
 * BODY.PEEK, so checking never marks mail as read or changes the mailbox.
 * The password is read ONLY from an environment variable.
 */
const net = require('net');
const tls = require('tls');
const fs = require('fs');

class ImapError extends Error {
  constructor(message, { stage } = {}) { super(message); this.stage = stage; }
}

const IMAP_DEFAULTS = { host: '', port: 993, user: '', passwordEnv: 'LEONIDAS_IMAP_PASSWORD', mailbox: 'INBOX', timeoutMs: 30000, caFile: '', rejectUnauthorized: true, allowPlaintext: false };

function resolveAccount(raw = {}) {
  const a = { ...IMAP_DEFAULTS, ...raw };
  a.port = Number(a.port);
  a.address = String(raw.address || raw.user || '').trim().toLowerCase();
  return a;
}

/** Config problems for one inbox account. */
function accountProblems(raw, label, env = process.env) {
  const a = resolveAccount(raw), p = [];
  if ('password' in raw || 'pass' in raw) p.push(`${label}.password must not be in the config file; put it in the env var named by ${label}.passwordEnv`);
  if (!a.host) p.push(`${label}.host is not set (Gmail: imap.gmail.com; cPanel: mail.yourdomain.com)`);
  if (!a.user) p.push(`${label}.user is not set (the full email address)`);
  if (!/^[A-Z_][A-Z0-9_]*$/.test(a.passwordEnv)) p.push(`${label}.passwordEnv must be an environment variable name`);
  else if (!env[a.passwordEnv]) p.push(`environment variable ${a.passwordEnv} (password for ${a.user || label}) is not set`);
  return p;
}

const quote = s => '"' + String(s).replace(/[\\"]/g, m => '\\' + m) + '"';

/**
 * Response reader. The socket is read as latin1 so string length == byte count, which keeps
 * IMAP literals ({n}) exact. Each response is {text: [segments], literals: [strings]}.
 */
function reader(sock, timeoutMs) {
  let buf = '', closed = null;
  const ready = [], waiters = [];
  let cur = null; // response being assembled
  const parse = () => {
    for (;;) {
      if (cur && cur.need !== undefined) {
        if (buf.length < cur.need) return;
        cur.literals.push(buf.slice(0, cur.need)); buf = buf.slice(cur.need); delete cur.need;
      }
      const i = buf.indexOf('\r\n');
      if (i < 0) return;
      const line = buf.slice(0, i); buf = buf.slice(i + 2);
      if (!cur) cur = { text: [], literals: [] };
      const m = line.match(/\{(\d+)\}$/);
      cur.text.push(line);
      if (m) { cur.need = Number(m[1]); continue; }
      const done = cur; cur = null;
      if (waiters.length) waiters.shift().resolve(done); else ready.push(done);
    }
  };
  sock.setEncoding('latin1');
  sock.on('data', d => { buf += d; parse(); });
  const fail = e => { closed = e; while (waiters.length) waiters.shift().reject(e); };
  sock.on('error', e => fail(new ImapError(e.message, { stage: 'io' })));
  sock.on('close', () => fail(new ImapError('connection closed by server', { stage: 'io' })));
  return {
    next(stage) {
      if (ready.length) return Promise.resolve(ready.shift());
      if (closed) return Promise.reject(new ImapError(`${stage}: ${closed.message}`, { stage }));
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => { reject(new ImapError(`${stage}: timeout after ${timeoutMs}ms`, { stage })); sock.destroy(); }, timeoutMs);
        waiters.push({ resolve: v => { clearTimeout(t); resolve(v); }, reject: e => { clearTimeout(t); reject(e); } });
      });
    },
  };
}

function connect(a, tlsOpts) {
  return new Promise((resolve, reject) => {
    const plain = a.allowPlaintext && a.port !== 993;
    const sock = plain ? net.connect({ host: a.host, port: a.port }) : tls.connect({ host: a.host, port: a.port, ...tlsOpts });
    const t = setTimeout(() => { sock.destroy(); reject(new ImapError(`connect timeout to ${a.host}:${a.port}`, { stage: 'connect' })); }, a.timeoutMs);
    sock.once(plain ? 'connect' : 'secureConnect', () => { clearTimeout(t); resolve({ sock, encrypted: !plain }); });
    sock.once('error', e => { clearTimeout(t); reject(new ImapError(`connect: ${e.message}`, { stage: 'connect' })); });
  });
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const imapDate = d => `${d.getUTCDate()}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()}`;

/**
 * Fetch recent messages from one account without changing anything on the server.
 * opts: { since: Date, skip: Set of "uidvalidity:uid" keys already seen, max, env }
 * Returns { uidValidity, messages: [{key, uid, header, text, internalDate}] } (raw header/text, latin1).
 */
async function fetchRecent(raw, { since, skip = new Set(), max = 50, env = process.env } = {}) {
  const a = resolveAccount(raw);
  const pass = env[a.passwordEnv];
  if (!pass) throw new ImapError(`environment variable ${a.passwordEnv} is not set`, { stage: 'config' });
  const tlsOpts = { servername: net.isIP(a.host) ? undefined : a.host, rejectUnauthorized: a.rejectUnauthorized !== false, minVersion: 'TLSv1.2' };
  if (a.caFile) tlsOpts.ca = fs.readFileSync(a.caFile);
  const { sock } = await connect(a, tlsOpts);
  const r = reader(sock, a.timeoutMs);
  let n = 0;
  const cmd = async (line, stage) => {
    const tag = 'L' + (++n);
    sock.write(`${tag} ${line}\r\n`);
    const untagged = [];
    for (;;) {
      const res = await r.next(stage);
      const first = res.text[0];
      if (first.startsWith(tag + ' ')) {
        if (!/^\S+ OK/i.test(first)) throw new ImapError(`${stage} failed: ${first.slice(tag.length + 1)}`, { stage });
        return untagged;
      }
      untagged.push(res);
    }
  };
  try {
    const g = await r.next('greeting');
    if (!/^\* (OK|PREAUTH)/i.test(g.text[0])) throw new ImapError(`greeting: ${g.text[0]}`, { stage: 'greeting' });
    await cmd(`LOGIN ${quote(a.user)} ${quote(pass)}`, 'LOGIN');
    const ex = await cmd(`EXAMINE ${quote(a.mailbox)}`, 'EXAMINE');
    const uv = ex.map(x => x.text.join(' ').match(/\[UIDVALIDITY (\d+)\]/i)).find(Boolean);
    const uidValidity = uv ? uv[1] : '0';
    const crit = since ? `SINCE ${imapDate(since)}` : 'ALL';
    const s = await cmd(`UID SEARCH ${crit}`, 'SEARCH');
    const uids = s.map(x => x.text.join(' ')).filter(t => /^\* SEARCH/i.test(t))
      .flatMap(t => t.replace(/^\* SEARCH/i, '').trim().split(/\s+/)).filter(Boolean).map(Number).sort((x, y) => x - y);
    const want = uids.filter(u => !skip.has(`${uidValidity}:${u}`)).slice(-max);
    const messages = [];
    if (want.length) {
      const f = await cmd(`UID FETCH ${want.join(',')} (UID INTERNALDATE BODY.PEEK[HEADER] BODY.PEEK[TEXT]<0.60000>)`, 'FETCH');
      for (const res of f) {
        if (!/^\* \d+ FETCH/i.test(res.text[0])) continue;
        const all = res.text.join(' ');
        const uid = Number((all.match(/\bUID (\d+)/i) || [])[1]);
        if (!uid) continue;
        let header = '', text = '';
        res.literals.forEach((lit, i) => {
          const before = res.text[i] || '';
          if (/BODY\[HEADER\] \{\d+\}$/i.test(before)) header = lit;
          else if (/BODY\[TEXT\](<\d+>)? \{\d+\}$/i.test(before)) text = lit;
        });
        if (!text) { const q = all.match(/BODY\[TEXT\](?:<\d+>)? "((?:[^"\\]|\\.)*)"/i); if (q) text = q[1].replace(/\\(.)/g, '$1'); }
        const internalDate = (all.match(/INTERNALDATE "([^"]+)"/i) || [])[1] || '';
        messages.push({ key: `${uidValidity}:${uid}`, uid, header, text, internalDate });
      }
    }
    try { await cmd('LOGOUT', 'LOGOUT'); } catch { /* ignore */ }
    return { uidValidity, messages };
  } finally { sock.destroy(); }
}

// ---------- MIME parsing (just enough to read a reply) ----------

function decodeCharset(latin1, charset) {
  const bytes = Buffer.from(latin1, 'latin1');
  const cs = String(charset || 'utf-8').toLowerCase().replace(/^"|"$/g, '');
  try { return new TextDecoder(cs === 'us-ascii' ? 'utf-8' : cs).decode(bytes); } catch { return bytes.toString('utf8'); }
}

function decodeQP(s) {
  return s.replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

/** RFC 2047 encoded words: =?utf-8?B?...?= and =?utf-8?Q?...?= */
function decodeWords(s) {
  return String(s || '').replace(/(=\?[^?]+\?[BbQq]\?[^?]*\?=)\s+(?==\?)/g, '$1').replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, cs, enc, data) => {
    const latin1 = enc.toUpperCase() === 'B' ? Buffer.from(data, 'base64').toString('latin1') : decodeQP(data.replace(/_/g, ' '));
    return decodeCharset(latin1, cs);
  });
}

/** Parse a header block into {name(lowercase): [values]} (unfolded, decoded). */
function parseHeaders(block) {
  const out = {};
  const lines = String(block || '').replace(/\r\n/g, '\n').split('\n');
  let last = null;
  for (const line of lines) {
    if (!line) continue;
    if (/^[ \t]/.test(line) && last) { last.v += ' ' + line.trim(); continue; }
    const i = line.indexOf(':');
    if (i <= 0) continue;
    last = { k: line.slice(0, i).trim().toLowerCase(), v: line.slice(i + 1).trim() };
    (out[last.k] = out[last.k] || []).push(last);
  }
  const h = {};
  for (const [k, arr] of Object.entries(out)) h[k] = arr.map(x => decodeWords(x.v));
  return h;
}

const param = (value, name) => { const m = String(value || '').match(new RegExp(`${name}\\s*=\\s*("([^"]*)"|[^;\\s]+)`, 'i')); return m ? (m[2] !== undefined ? m[2] : m[1]) : ''; };

/** Addresses in a header value: [{name, email}] */
function parseAddresses(v) {
  const out = [];
  for (const part of String(v || '').split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)) {
    const m = part.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/) || part.match(/^\s*()([^\s<>]+@[^\s<>]+)\s*$/);
    if (m) out.push({ name: m[1].trim(), email: m[2].trim().toLowerCase() });
  }
  return out;
}

function htmlToText(html) {
  return html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
}

/** Decode one MIME entity (headers object + raw latin1 body) to {plain, html, attachments[]}. */
function walk(h, body, out, depth = 0) {
  const ct = (h['content-type'] || ['text/plain'])[0];
  const type = ct.split(';')[0].trim().toLowerCase();
  const cte = String((h['content-transfer-encoding'] || [''])[0]).toLowerCase();
  const disp = String((h['content-disposition'] || [''])[0]).toLowerCase();
  if (type.startsWith('multipart/') && depth < 8) {
    const b = param(ct, 'boundary');
    if (!b) return;
    const parts = body.split(new RegExp(`\\r?\\n?--${b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:--)?[ \\t]*\\r?\\n?`));
    for (const p of parts) {
      const sep = p.search(/\r?\n\r?\n/);
      if (sep < 0) continue;
      walk(parseHeaders(p.slice(0, sep)), p.slice(sep).replace(/^\r?\n\r?\n/, ''), out, depth + 1);
    }
    return;
  }
  const name = param(disp, 'filename') || param(ct, 'name');
  if (disp.startsWith('attachment') || (name && !type.startsWith('text/'))) { out.attachments.push({ name: decodeWords(name), type }); return; }
  if (type === 'message/delivery-status') { out.dsn += body; return; }
  if (!type.startsWith('text/')) return;
  let raw = body;
  if (cte === 'base64') raw = Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('latin1');
  else if (cte === 'quoted-printable') raw = decodeQP(body);
  const text = decodeCharset(raw, param(ct, 'charset'));
  if (type === 'text/html') { if (!out.html) out.html = text; } else if (!out.plain) out.plain = text;
}

/** Their own words: drop quoted history ("> ...", "On ... wrote:", "-----Original Message-----"). */
function ownWords(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const kept = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*>/.test(l)) continue;
    if (/^\s*On .{0,200}wrote:\s*$/i.test(l) || (/^\s*On .{0,200}$/i.test(l) && /wrote:\s*$/i.test(lines[i + 1] || ''))) break;
    if (/^\s*-{2,}\s*(Original Message|Forwarded message)\s*-{2,}/i.test(l)) break;
    if (/^\s*From:\s.+/i.test(l) && /^\s*(Sent|Date|To):\s/i.test(lines[i + 1] || '')) break;
    if (/^\s*_{10,}\s*$/.test(l)) break;
    kept.push(l);
  }
  return kept.join('\n').trim();
}

/** Turn a raw fetched message into a readable record. */
function parseMessage({ header, text }) {
  const h = parseHeaders(header);
  const out = { plain: '', html: '', attachments: [], dsn: '' };
  walk(h, text, out);
  const body = (out.plain || htmlToText(out.html) || '').trim();
  const one = k => (h[k] || [''])[0];
  const from = parseAddresses(one('from'))[0] || { name: '', email: '' };
  const replyTo = parseAddresses(one('reply-to'))[0] || null;
  const recipients = ['to', 'cc', 'delivered-to', 'x-original-to', 'x-forwarded-to'].flatMap(k => (h[k] || []).flatMap(parseAddresses)).map(x => x.email);
  return {
    headers: h, from, replyTo, recipients: [...new Set(recipients)],
    subject: one('subject'), date: one('date'), messageId: one('message-id'), references: one('references'),
    body, own: ownWords(body), attachments: out.attachments, dsn: out.dsn,
  };
}

module.exports = { IMAP_DEFAULTS, ImapError, resolveAccount, accountProblems, fetchRecent, parseMessage, parseHeaders, parseAddresses, decodeWords, ownWords, imapDate };
