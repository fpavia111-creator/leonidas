'use strict';
/** Tiny fake SMTP server for tests. Usable in-process (start()) or as a child (node fake-smtp.js '<json opts>'). */
const net = require('net');
const tls = require('tls');
const fs = require('fs');

function start({ mode = 'starttls', key, cert, user = 'u@example.test', pass = 'secret', auth = ['PLAIN', 'LOGIN'], rejectRcpt = null, tempFailRcpt = null, log = null } = {}) {
  const messages = [];
  const tlsCtx = key ? { key: fs.readFileSync(key), cert: fs.readFileSync(cert) } : null;
  const handler = raw => {
    let sock = raw, buf = '', inData = false, data = '', secure = mode === 'tls', authed = false, loginStep = 0, loginUser = '';
    const sess = { from: null, to: [], secure, authUser: null, commands: [] };
    const say = l => sock.write(l + '\r\n');
    const onLine = line => {
      if (inData) {
        if (line === '.') { inData = false; const m = { ...sess, to: [...sess.to], secure, data }; messages.push(m); if (log) fs.writeFileSync(log, JSON.stringify(messages)); data = ''; return say('250 2.0.0 queued as FAKE1'); }
        data += (line.startsWith('..') ? line.slice(1) : line) + '\n'; return;
      }
      sess.commands.push(/^AUTH|^[A-Za-z0-9+/=]{8,}$/.test(line) ? '[auth]' : line);
      if (loginStep === 1) { loginUser = Buffer.from(line, 'base64').toString(); loginStep = 2; return say('334 UGFzc3dvcmQ6'); }
      if (loginStep === 2) { loginStep = 0; const ok = loginUser === user && Buffer.from(line, 'base64').toString() === pass; if (ok) { authed = true; sess.authUser = loginUser; } return say(ok ? '235 2.7.0 ok' : '535 5.7.8 bad credentials'); }
      const [verb] = line.split(' '); const V = verb.toUpperCase();
      if (V === 'EHLO') { const ext = ['250-fake.test']; if (mode === 'starttls' && !secure) ext.push('250-STARTTLS'); if (secure || mode === 'plain') ext.push('250-AUTH ' + auth.join(' ')); ext.push('250 8BITMIME'); return say(ext.join('\r\n')); }
      if (V === 'STARTTLS') {
        say('220 2.0.0 go ahead');
        raw.removeAllListeners('data');
        const t = new tls.TLSSocket(raw, { isServer: true, ...tlsCtx });
        sock = t; secure = true; sess.secure = true; buf = '';
        t.setEncoding('utf8'); t.on('data', onData); t.on('error', () => {});
        return;
      }
      if (V === 'AUTH') {
        if (!secure && mode !== 'plain') return say('538 5.7.11 encryption required');
        const [, mech, arg] = line.split(' ');
        if (mech.toUpperCase() === 'PLAIN') { const [, u, p] = Buffer.from(arg || '', 'base64').toString().split('\0'); const ok = u === user && p === pass; if (ok) { authed = true; sess.authUser = u; } return say(ok ? '235 2.7.0 ok' : '535 5.7.8 bad credentials'); }
        if (mech.toUpperCase() === 'LOGIN') { loginStep = 1; return say('334 VXNlcm5hbWU6'); }
        return say('504 unsupported');
      }
      if (V === 'MAIL') { if (!authed) return say('530 5.7.0 auth required'); sess.from = line.match(/<(.*)>/)[1]; return say('250 ok'); }
      if (V === 'RCPT') { const to = line.match(/<(.*)>/)[1]; if (rejectRcpt && to.includes(rejectRcpt)) return say('550 5.1.1 user unknown'); if (tempFailRcpt && to.includes(tempFailRcpt)) return say('451 4.7.1 try later'); sess.to.push(to); return say('250 ok'); }
      if (V === 'DATA') { inData = true; return say('354 end with .'); }
      if (V === 'QUIT') { say('221 bye'); return sock.end(); }
      if (V === 'RSET' || V === 'NOOP') return say('250 ok');
      say('500 unknown');
    };
    const onData = d => { buf += d; let i; while ((i = buf.indexOf('\r\n')) !== -1) { const l = buf.slice(0, i); buf = buf.slice(i + 2); onLine(l); } };
    raw.setEncoding && raw.setEncoding('utf8');
    sock.on('data', onData); sock.on('error', () => {});
    say('220 fake.test ESMTP');
  };
  const server = mode === 'tls' ? tls.createServer(tlsCtx, handler) : net.createServer(handler);
  return new Promise(res => server.listen(0, '127.0.0.1', () => res({ port: server.address().port, messages, close: () => new Promise(r => server.close(r)) })));
}

module.exports = { start };

if (require.main === module) {
  start(JSON.parse(process.argv[2] || '{}')).then(s => { process.stdout.write(`PORT ${s.port}\n`); });
}
