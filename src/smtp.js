'use strict';
/**
 * Minimal SMTP submission client on Node's built-in net/tls (no dependencies).
 * Suited to cPanel / shared-host mailboxes:
 *   port 465 -> implicit TLS ("SSL"); port 587 -> plain connect + mandatory STARTTLS.
 * AUTH PLAIN or LOGIN. Password is read ONLY from an environment variable.
 * Never sends credentials over an unencrypted connection unless allowPlaintext=true (tests only).
 */
const net = require('net');
const tls = require('tls');
const fs = require('fs');
const os = require('os');

class SmtpError extends Error {
  constructor(message, { code, stage, enhanced } = {}) { super(message); this.code = code; this.stage = stage; this.enhanced = enhanced; }
  get permanent() { return this.code >= 500 && this.code < 600; }
}

const SMTP_DEFAULTS = { host: '', port: 587, secure: null, user: '', passwordEnv: 'LEONIDAS_SMTP_PASSWORD', heloName: '', timeoutMs: 30000, caFile: '', rejectUnauthorized: true, allowPlaintext: false };

function resolveSmtp(cfg) {
  const s = { ...SMTP_DEFAULTS, ...((cfg.sending && cfg.sending.smtp) || {}) };
  s.port = Number(s.port);
  if (s.secure === null || s.secure === undefined || s.secure === '') s.secure = s.port === 465;
  return s;
}

/** Config problems that block SMTP delivery. */
function smtpProblems(cfg, env = process.env) {
  const s = resolveSmtp(cfg), p = [];
  const raw = (cfg.sending && cfg.sending.smtp) || {};
  if ('password' in raw || 'pass' in raw) p.push('sending.smtp.password must not be in the config file; put it in the env var named by sending.smtp.passwordEnv');
  if (!s.host) p.push('sending.smtp.host is not set');
  if (!Number.isInteger(s.port) || s.port < 1 || s.port > 65535) p.push('sending.smtp.port must be 465 (SSL) or 587 (STARTTLS)');
  if (!s.user) p.push('sending.smtp.user is not set');
  if (!/^[A-Z_][A-Z0-9_]*$/.test(s.passwordEnv)) p.push('sending.smtp.passwordEnv must be an environment variable name');
  else if (!env[s.passwordEnv]) p.push(`environment variable ${s.passwordEnv} (SMTP password) is not set`);
  return p;
}

/** Line reader + command/response over a socket that can be upgraded to TLS. */
function session(sock, timeoutMs) {
  let buf = '', waiter = null, closedErr = null;
  const lines = [];
  const pump = () => {
    // collect a complete multi-line reply: "250-..." ... "250 ..."
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) { lines.push(buf.slice(0, idx).replace(/\r$/, '')); buf = buf.slice(idx + 1); }
    const end = lines.findIndex(l => /^\d{3}(?: |$)/.test(l));
    if (end !== -1 && waiter) {
      const reply = lines.splice(0, end + 1);
      const code = Number(reply[reply.length - 1].slice(0, 3));
      const w = waiter; waiter = null; clearTimeout(w.t);
      w.resolve({ code, lines: reply.map(l => l.slice(4)), text: reply.map(l => l.slice(4)).join(' ') });
    }
  };
  const attach = s => {
    s.setEncoding('utf8');
    s.on('data', d => { buf += d; pump(); });
    s.on('error', e => { closedErr = e; if (waiter) { const w = waiter; waiter = null; clearTimeout(w.t); w.reject(e); } });
    s.on('close', () => { if (!closedErr) closedErr = new Error('connection closed'); if (waiter) { const w = waiter; waiter = null; clearTimeout(w.t); w.reject(new SmtpError('connection closed by server', { stage: 'io' })); } });
  };
  attach(sock);
  const api = {
    sock,
    read(stage) {
      return new Promise((resolve, reject) => {
        if (closedErr && !lines.length) return reject(new SmtpError(`${stage}: ${closedErr.message}`, { stage }));
        waiter = { resolve, reject, t: setTimeout(() => { waiter = null; reject(new SmtpError(`${stage}: timeout after ${timeoutMs}ms`, { stage })); sock.destroy(); }, timeoutMs) };
        pump();
      });
    },
    async cmd(line, expect, stage, logLine) {
      api.sock.write(line + '\r\n');
      const r = await api.read(stage);
      if (!expect.includes(r.code)) throw new SmtpError(`${stage} failed: ${r.code} ${r.text}${logLine ? '' : ''}`, { code: r.code, stage, enhanced: (r.text.match(/^\d\.\d{1,3}\.\d{1,3}/) || [])[0] });
      return r;
    },
    upgrade(tlsOpts) {
      return new Promise((resolve, reject) => {
        sock.removeAllListeners('data'); sock.removeAllListeners('close'); sock.removeAllListeners('error');
        const t = tls.connect({ socket: sock, ...tlsOpts }, () => { api.sock = t; resolve(); });
        t.once('error', reject);
        buf = ''; closedErr = null; attach(t);
      });
    },
  };
  return api;
}

function connect(s, tlsOpts) {
  return new Promise((resolve, reject) => {
    const sock = s.secure ? tls.connect({ host: s.host, port: s.port, ...tlsOpts }) : net.connect({ host: s.host, port: s.port });
    const t = setTimeout(() => { sock.destroy(); reject(new SmtpError(`connect timeout to ${s.host}:${s.port}`, { stage: 'connect' })); }, s.timeoutMs);
    sock.once(s.secure ? 'secureConnect' : 'connect', () => { clearTimeout(t); resolve(sock); });
    sock.once('error', e => { clearTimeout(t); reject(new SmtpError(`connect: ${e.message}`, { stage: 'connect' })); });
  });
}

/** Dot-stuff and normalize line endings for DATA. */
function dataPayload(eml) {
  return String(eml).replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..').replace(/(\r\n)?$/, '\r\n') + '.';
}

const extList = r => r.lines.slice(1).map(l => l.toUpperCase());

/**
 * Deliver one RFC 5322 message. envelope: {from, to}. Returns {code, response}.
 * Throws SmtpError (err.permanent true for 5xx).
 */
async function sendMail(smtpCfg, eml, envelope, { env = process.env } = {}) {
  const s = { ...SMTP_DEFAULTS, ...smtpCfg };
  s.port = Number(s.port); if (s.secure === null || s.secure === undefined || s.secure === '') s.secure = s.port === 465;
  const pass = env[s.passwordEnv];
  if (!pass) throw new SmtpError(`environment variable ${s.passwordEnv} is not set`, { stage: 'config' });
  if (/[\r\n<>]/.test(envelope.from + envelope.to)) throw new SmtpError('invalid envelope address', { stage: 'config' });
  const tlsOpts = { servername: net.isIP(s.host) ? undefined : s.host, rejectUnauthorized: s.rejectUnauthorized !== false, minVersion: 'TLSv1.2' };
  if (s.caFile) tlsOpts.ca = fs.readFileSync(s.caFile);
  const sock = await connect(s, tlsOpts);
  const c = session(sock, s.timeoutMs);
  const helo = s.heloName || os.hostname() || 'localhost';
  try {
    const g = await c.read('greeting');
    if (g.code !== 220) throw new SmtpError(`greeting: ${g.code} ${g.text}`, { code: g.code, stage: 'greeting' });
    let ehlo = await c.cmd(`EHLO ${helo}`, [250], 'EHLO');
    let encrypted = s.secure;
    if (!encrypted) {
      if (extList(ehlo).some(x => x.startsWith('STARTTLS'))) {
        await c.cmd('STARTTLS', [220], 'STARTTLS');
        await c.upgrade(tlsOpts);
        encrypted = true;
        ehlo = await c.cmd(`EHLO ${helo}`, [250], 'EHLO');
      } else if (!s.allowPlaintext) throw new SmtpError('server does not offer STARTTLS; refusing to send credentials in plaintext', { stage: 'STARTTLS' });
    }
    const auth = (extList(ehlo).find(x => x.startsWith('AUTH')) || '').split(/[ =]/).slice(1);
    if (auth.includes('PLAIN') || !auth.includes('LOGIN')) {
      await c.cmd('AUTH PLAIN ' + Buffer.from(`\0${s.user}\0${pass}`).toString('base64'), [235], 'AUTH');
    } else {
      await c.cmd('AUTH LOGIN', [334], 'AUTH');
      await c.cmd(Buffer.from(s.user).toString('base64'), [334], 'AUTH');
      await c.cmd(Buffer.from(pass).toString('base64'), [235], 'AUTH');
    }
    await c.cmd(`MAIL FROM:<${envelope.from}>`, [250], 'MAIL FROM');
    await c.cmd(`RCPT TO:<${envelope.to}>`, [250, 251], 'RCPT TO');
    await c.cmd('DATA', [354], 'DATA');
    const r = await c.cmd(dataPayload(eml), [250], 'DATA end');
    try { await c.cmd('QUIT', [221], 'QUIT'); } catch { /* ignore */ }
    return { code: r.code, response: r.text, encrypted };
  } finally { c.sock.destroy(); }
}

module.exports = { SMTP_DEFAULTS, SmtpError, resolveSmtp, smtpProblems, sendMail, dataPayload };
