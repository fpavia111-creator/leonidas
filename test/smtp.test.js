'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const fake = require('./fake-smtp');
const { sendMail, smtpProblems, dataPayload } = require('../src/smtp');
const { validateConfig } = require('../src/config');
const { lw, LEAD, GOOD, tmp, cfg } = require('./helpers');

const ENV = { LEONIDAS_SMTP_PASSWORD: 'secret' };
const EML = 'From: <u@example.test>\r\nTo: <o@x.test>\r\nSubject: hi\r\n\r\nline one\r\n.starts with dot\r\n';

// self-signed cert for localhost, generated once with openssl
let KEY, CERT;
function makeCert() {
  const d = tmp(); KEY = path.join(d, 'k.pem'); CERT = path.join(d, 'c.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', KEY, '-out', CERT, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' });
}
let haveOpenssl = true;
try { makeCert(); } catch { haveOpenssl = false; }

describe('smtp client (in-process fake server)', { skip: !haveOpenssl && 'openssl not available' }, () => {
  it('587: STARTTLS upgrade, AUTH PLAIN, dot-stuffing, envelope', async () => {
    const s = await fake.start({ mode: 'starttls', key: KEY, cert: CERT });
    const r = await sendMail({ host: '127.0.0.1', port: s.port, user: 'u@example.test', caFile: CERT }, EML, { from: 'u@example.test', to: 'o@x.test' }, { env: ENV });
    assert.equal(r.code, 250); assert.equal(r.encrypted, true);
    const m = s.messages[0];
    assert.equal(m.secure, true); assert.equal(m.authUser, 'u@example.test'); assert.deepEqual(m.to, ['o@x.test']);
    assert.match(m.data, /\n\.starts with dot\n/);
    await s.close();
  });
  it('465: implicit TLS, AUTH LOGIN when PLAIN is not offered', async () => {
    const s = await fake.start({ mode: 'tls', key: KEY, cert: CERT, auth: ['LOGIN'] });
    const r = await sendMail({ host: '127.0.0.1', port: s.port, secure: true, user: 'u@example.test', caFile: CERT }, EML, { from: 'u@example.test', to: 'o@x.test' }, { env: ENV });
    assert.equal(r.code, 250); assert.equal(s.messages[0].authUser, 'u@example.test');
    await s.close();
  });
  it('rejects an untrusted certificate by default', async () => {
    const s = await fake.start({ mode: 'tls', key: KEY, cert: CERT });
    await assert.rejects(sendMail({ host: '127.0.0.1', port: s.port, secure: true, user: 'u@example.test' }, EML, { from: 'a@b.test', to: 'o@x.test' }, { env: ENV }));
    assert.equal(s.messages.length, 0); await s.close();
  });
  it('refuses plaintext AUTH when STARTTLS is missing', async () => {
    const s = await fake.start({ mode: 'plain' });
    await assert.rejects(sendMail({ host: '127.0.0.1', port: s.port, user: 'u@example.test' }, EML, { from: 'a@b.test', to: 'o@x.test' }, { env: ENV }), /plaintext/);
    await s.close();
  });
  it('bad password -> permanent 535', async () => {
    const s = await fake.start({ mode: 'starttls', key: KEY, cert: CERT });
    await assert.rejects(sendMail({ host: '127.0.0.1', port: s.port, user: 'u@example.test', caFile: CERT }, EML, { from: 'a@b.test', to: 'o@x.test' }, { env: { LEONIDAS_SMTP_PASSWORD: 'nope' } }), e => e.code === 535 && e.permanent);
    await s.close();
  });
  it('missing password env var fails before connecting', async () => {
    await assert.rejects(sendMail({ host: '127.0.0.1', port: 1, user: 'u' }, EML, { from: 'a@b.test', to: 'o@x.test' }, { env: {} }), /LEONIDAS_SMTP_PASSWORD/);
  });
});

describe('smtp config', () => {
  it('password never allowed in config; env var required', () => {
    const c = cfg({ sending: { transport: 'smtp', smtp: { host: 'mail.example.test', port: 465, user: 'u', password: 'x' } } });
    assert.match(validateConfig(c).errors.join(), /must not be stored/);
    assert.ok(smtpProblems(c, {}).some(p => /LEONIDAS_SMTP_PASSWORD/.test(p)));
  });
  it('dot-stuffing payload', () => { assert.equal(dataPayload('a\n.b'), 'a\r\n..b\r\n.'); });
});

describe('engine over smtp (fake server in a child process)', { skip: !haveOpenssl && 'openssl not available' }, () => {
  let child, port, logFile;
  before(async () => {
    logFile = path.join(tmp(), 'msgs.json');
    child = spawn(process.execPath, [path.join(__dirname, 'fake-smtp.js'), JSON.stringify({ mode: 'starttls', key: KEY, cert: CERT, log: logFile, rejectRcpt: 'ghost@', tempFailRcpt: 'busy@' })]);
    port = await new Promise(res => child.stdout.on('data', d => { const m = String(d).match(/PORT (\d+)/); if (m) res(Number(m[1])); }));
  });
  after(() => child.kill());
  const inst = () => {
    process.env.LEONIDAS_SMTP_PASSWORD = 'secret';
    return lw({ over: { sending: { transport: 'smtp', smtp: { host: '127.0.0.1', port, user: 'u@example.test', caFile: CERT } } } });
  };
  const queue = (i, lead) => { const { added: [l] } = i.addLeads([lead]); const m = i.queueEmail({ leadId: l.id, ...GOOD, why: 'x' }); i.approve(m.id); return m; };
  it('delivers an approved, gated message with footer and List-Unsubscribe', () => {
    const i = inst(); queue(i, LEAD);
    const r = i.sendApproved();
    assert.equal(r[0].status, 'sent');
    const got = JSON.parse(fs.readFileSync(logFile, 'utf8')).pop();
    assert.deepEqual(got.to, [LEAD.email]); assert.equal(got.from, 'kurt@acme.test');
    assert.match(got.data, /List-Unsubscribe:/); assert.match(got.data, /100 Main St/);
  });
  it('gates still apply before SMTP is touched (unapproved, unverified, off-day)', () => {
    const before = fs.existsSync(logFile) ? JSON.parse(fs.readFileSync(logFile, 'utf8')).length : 0;
    const i = inst();
    const { added: [l] } = i.addLeads([{ ...LEAD, email: 'new@x.test', emailVerified: false }]);
    const m = i.queueEmail({ leadId: l.id, ...GOOD, why: 'x' }); i.approve(m.id);
    assert.equal(i.sendApproved()[0].status, 'held');
    const i2 = inst(); i2.setNow(new Date('2026-10-22T15:00:00Z')); queue(i2, LEAD);
    assert.equal(i2.sendApproved()[0].status, 'scheduled');
    const i3 = inst(); const { added: [l3] } = i3.addLeads([LEAD]); i3.queueEmail({ leadId: l3.id, ...GOOD, why: 'x' });
    assert.equal(i3.sendApproved().length, 0);
    assert.equal(fs.existsSync(logFile) ? JSON.parse(fs.readFileSync(logFile, 'utf8')).length : 0, before);
  });
  it('550 on RCPT -> failed + hard bounce + suppressed', () => {
    const i = inst(); queue(i, { ...LEAD, email: 'ghost@x.test' });
    const r = i.sendApproved()[0];
    assert.equal(r.status, 'failed');
    assert.ok(i.suppression.match('ghost@x.test'));
    assert.equal(i.bounces()[0].type, 'hard');
  });
  it('451 on RCPT -> retry, message stays approved', () => {
    const i = inst(); const m = queue(i, { ...LEAD, email: 'busy@x.test' });
    assert.equal(i.sendApproved()[0].status, 'retry');
    assert.equal(i.outbox().find(x => x.id === m.id).status, 'approved');
  });
});
