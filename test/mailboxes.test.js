'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { validateConfig, sendReadiness } = require('../src/config');
const { lw, LEAD, GOOD, TUE, tmp, cfg } = require('./helpers');

const POOL = [{ email: 'a@acme.test' }, { email: 'b@acme.test' }, { email: 'c@acme.test' }];
const lead = i => ({ ...LEAD, email: `owner@biz${i}.test`, company: `Biz ${i}` });
const queue = (i, l) => { const { added: [x] } = i.addLeads([l]); const m = i.queueEmail({ leadId: (x || i.getLead(l.email)).id, ...GOOD, why: 'x' }); i.approve(m.id); return m; };
const fromHeader = (i, id) => fs.readFileSync(path.join(i.dir, 'sent', `${id}.eml`), 'utf8').match(/^From: (.*)$/m)[1];

describe('mailbox pool (file transport)', () => {
  it('rotates evenly across mailboxes and records which one sent', () => {
    const i = lw({ over: { sending: { mailboxes: POOL } } });
    const ms = [0, 1, 2, 3, 4, 5].map(n => queue(i, lead(n)));
    const r = i.sendApproved();
    assert.deepEqual(r.map(x => x.status), Array(6).fill('sent'));
    assert.deepEqual(r.map(x => x.mailbox), ['a@acme.test', 'b@acme.test', 'c@acme.test', 'a@acme.test', 'b@acme.test', 'c@acme.test']);
    assert.deepEqual(i.sendLog().map(x => x.mailbox), r.map(x => x.mailbox));
    assert.equal(fromHeader(i, ms[1].id), '"Kurt" <b@acme.test>');
  });

  it('each mailbox has its own daily cap', () => {
    const i = lw({ over: { sending: { mailboxes: [{ email: 'a@acme.test', dailyCap: 1 }, { email: 'b@acme.test', dailyCap: 5 }] } } });
    [0, 1, 2].forEach(n => queue(i, lead(n)));
    assert.deepEqual(i.sendApproved().map(x => x.mailbox), ['a@acme.test', 'b@acme.test', 'b@acme.test']);
    const st = i.status();
    assert.equal(st.capToday, 6);
    assert.deepEqual(st.mailboxes.map(m => [m.email, m.sentToday, m.capToday]), [['a@acme.test', 1, 1], ['b@acme.test', 2, 5]]);
  });

  it('holds mail once every mailbox is at its cap', () => {
    const i = lw({ over: { sending: { dailyCap: 1, mailboxes: POOL.slice(0, 2) } } });
    [0, 1, 2].forEach(n => queue(i, lead(n)));
    const r = i.sendApproved();
    assert.deepEqual(r.map(x => x.status), ['sent', 'sent', 'held']);
    assert.match(r[2].reasons.join(), /daily cap reached \(2\/2/);
  });

  it('totalDailyCap limits the whole pool', () => {
    const i = lw({ over: { sending: { totalDailyCap: 2, mailboxes: POOL } } });
    [0, 1, 2].forEach(n => queue(i, lead(n)));
    const r = i.sendApproved();
    assert.deepEqual(r.map(x => x.status), ['sent', 'sent', 'held']);
    assert.equal(i.status().capToday, 2);
  });

  it('hourlyCap counts every mailbox in a rolling hour', () => {
    const i = lw({ over: { sending: { hourlyCap: 2, mailboxes: POOL } } });
    [0, 1, 2].forEach(n => queue(i, lead(n)));
    const r = i.sendApproved();
    assert.deepEqual(r.map(x => x.status), ['sent', 'sent', 'held']);
    assert.match(r[2].reasons.join(), /hourly cap reached \(2\/2/);
    i.setNow(new Date(TUE.getTime() + 61 * 60000));
    assert.equal(i.sendApproved()[0].status, 'sent');
  });

  it('a recipient keeps getting mail from the mailbox that first wrote to them', () => {
    const i = lw({ over: { sending: { mailboxes: [{ email: 'a@acme.test', dailyCap: 3 }, { email: 'b@acme.test' }] } } });
    [0, 1, 2].forEach(n => queue(i, lead(n)));
    assert.deepEqual(i.sendApproved().map(x => x.mailbox), ['a@acme.test', 'b@acme.test', 'a@acme.test']);
    const m = i.queueEmail({ leadId: i.getLead(lead(0).email).id, ...GOOD, why: 'follow-up' }); i.approve(m.id);
    assert.equal(i.sendApproved()[0].mailbox, 'a@acme.test'); // b is less used, but lead 0's thread is in a
    const m2 = i.queueEmail({ leadId: i.getLead(lead(0).email).id, ...GOOD, why: 'again' }); i.approve(m2.id);
    const r = i.sendApproved()[0];
    assert.equal(r.status, 'held');
    assert.match(r.reasons.join(), /emailed from a@acme\.test, which is at its daily cap \(3\/3\)/);
  });

  it('warmup ramps each mailbox from its own start date', () => {
    const i = lw({ over: { sending: { ramp: [1, 2], warmup: { enabled: true, startDate: '2026-10-20' }, mailboxes: [{ email: 'new@acme.test' }, { email: 'old@acme.test', warmupStartDate: '2026-10-01' }] } } });
    const st = i.status();
    assert.deepEqual(st.mailboxes.map(m => m.capToday), [1, 30]);
    assert.equal(st.capToday, 31);
  });

  it('without a pool, From is sender.email and status has no mailbox list', () => {
    const i = lw();
    const m = queue(i, lead(0));
    assert.equal(i.sendApproved()[0].status, 'sent');
    assert.equal(fromHeader(i, m.id), '"Kurt" <kurt@acme.test>');
    assert.equal(i.status().mailboxes, undefined);
  });

  it('stops checking once a limit holds every message, auditing only the first', () => {
    const i = lw({ over: { sending: { minIntervalSeconds: 60, mailboxes: POOL } } });
    [0, 1, 2, 3].forEach(n => queue(i, lead(n)));
    const r = i.sendApproved();
    assert.deepEqual(r.map(x => x.status), ['sent', 'held', 'held', 'held']);
    assert.match(r[3].reasons.join(), /send interval/);
    assert.equal(i.audit.all().filter(e => e.action === 'send_blocked').length, 1);
  });

  it('send --watch sends as limits allow and reports waiting once', async () => {
    const { watchSend } = require('../bin/leonidas');
    const i = lw({ over: { sending: { minIntervalSeconds: 60, mailboxes: POOL } } });
    fs.writeFileSync(path.join(i.dir, 'config.json'), JSON.stringify(i.cfg));
    [0, 1].forEach(n => queue(i, lead(n)));
    const prev = process.env.LEONIDAS_HOME; process.env.LEONIDAS_HOME = i.dir;
    const lines = [];
    let t = TUE.getTime();
    try { await watchSend(1, { passes: 3, log: l => lines.push(l), now: () => new Date(t += 1000) }); } finally { if (prev === undefined) delete process.env.LEONIDAS_HOME; else process.env.LEONIDAS_HOME = prev; }
    assert.equal(lines.length, 2);
    assert.match(lines[0], /sent msg_\w+ from a@acme\.test$/);
    assert.match(lines[1], /waiting: send interval/);
    assert.equal(i.sendLog().length, 1);
  });

  it('a bounce is credited to the mailbox that sent to that address', () => {
    const i = lw({ over: { sending: { mailboxes: POOL } } });
    [0, 1].forEach(n => queue(i, lead(n)));
    i.sendApproved();
    i.recordBounce({ email: lead(1).email, code: '550', diagnostic: 'user unknown' });
    assert.equal(i.bounces()[0].mailbox, 'b@acme.test');
    assert.deepEqual(i.status().mailboxes.map(m => m.hardBounces), [0, 1, 0]);
  });
});

describe('mailbox pool config', () => {
  const v = mailboxes => validateConfig(cfg({ sending: { transport: 'smtp', smtp: { host: 'mail.acme.test', port: 465 }, mailboxes } }));
  it('rejects passwords, duplicates, bad env names and non-addresses', () => {
    assert.match(v([{ email: 'a@acme.test', password: 'x' }]).errors.join(), /mailboxes\[0\]\.password must not be stored/);
    assert.match(v([{ email: 'a@acme.test' }, { email: 'A@acme.test' }]).errors.join(), /listed twice/);
    assert.match(v([{ email: 'a@acme.test', passwordEnv: 'not-ok' }]).errors.join(), /passwordEnv must be an environment variable name/);
    assert.match(v([{ email: 'nope' }]).errors.join(), /must be an email address/);
    assert.match(v([{ email: 'a@acme.test', dailyCap: -1 }]).errors.join(), /dailyCap must be a non-negative number/);
    assert.deepEqual(v([{ email: 'a@acme.test', passwordEnv: 'PW_A', dailyCap: 20 }]).errors, []);
  });
  it('warns when several mailboxes have no hourly cap', () => {
    assert.match(v(POOL).warnings.join(), /hourlyCap is 0/);
    const c = cfg({ sending: { transport: 'smtp', smtp: { host: 'mail.acme.test', port: 465 }, hourlyCap: 400, mailboxes: POOL } });
    assert.ok(!validateConfig(c).warnings.some(w => /hourlyCap/.test(w)));
  });
  it('sending is blocked only when no mailbox is usable', () => {
    const c = cfg({ sending: { transport: 'smtp', smtp: { host: 'mail.acme.test', port: 465 }, mailboxes: [{ email: 'a@acme.test', passwordEnv: 'LW_TEST_PW_A' }, { email: 'b@acme.test', passwordEnv: 'LW_TEST_PW_B' }] } });
    delete process.env.LW_TEST_PW_A; delete process.env.LW_TEST_PW_B;
    assert.match(sendReadiness(c).join(), /no usable mailbox/);
    process.env.LW_TEST_PW_A = 'x';
    assert.deepEqual(sendReadiness(c), []);
    delete process.env.LW_TEST_PW_A;
  });
});

describe('Harvey mailbox import', () => {
  const yaml = require('../src/yaml');
  const { fromHarvey } = require('../src/harvey');
  const { mailboxes } = require('../src/deliverability');
  const H = [
    'persona:', '  name: Francisco', '  email: main@one.test',
    'channels:', '  email:', '    provider: smtp', '    max_daily_sends: 300', '    max_hourly_sends: 450',
    '    mailboxes:',
    '    - {address: f1@one.test, password_env: MAILBOX_PASSWORD}',
    '    - {address: f2@two.test, password_env: MAILBOX_PASSWORD, smtp_host: mail.two.test, smtp_port: 465, imap_port: 993, send_ramp: [50, 100, 200, 300]}',
    '    - {address: off@one.test, enabled: false}', '',
  ].join('\n');
  it('reads flow lists and maps', () => {
    assert.deepEqual(yaml.parse('a: [1, two, "3, x"]\nb: {k: v, n: [1, {z: null}], u: https://x.test/a}\nc:\n- {p: 1}\n- [x, y]\n').value,
      { a: [1, 'two', '3, x'], b: { k: 'v', n: [1, { z: null }], u: 'https://x.test/a' }, c: [{ p: 1 }, ['x', 'y']] });
    assert.throws(() => yaml.parse('a: [1, 2\n'), /flow collection/);
  });
  it('carries mailboxes and the hourly cap over, main mailbox first', () => {
    const { config, notes } = fromHarvey(yaml.parse(H).value);
    assert.equal(config.sending.hourlyCap, 450);
    assert.deepEqual(config.sending.mailboxes, [
      { email: 'main@one.test' },
      { email: 'f1@one.test', passwordEnv: 'MAILBOX_PASSWORD' },
      { email: 'f2@two.test', passwordEnv: 'MAILBOX_PASSWORD', host: 'mail.two.test', port: 465 },
    ]);
    assert.ok(notes.some(n => /off@one\.test/.test(n)) && notes.some(n => /send_ramp is not carried over/.test(n)));
    const c = cfg({ sending: { ...config.sending, smtp: { host: 'mail.one.test', port: 587 } } });
    assert.deepEqual(validateConfig(c).errors, []);
    const [, f1, f2] = mailboxes(c);
    assert.deepEqual([f1.smtp.host, f1.smtp.port, f2.smtp.host, f2.smtp.port, f2.smtp.secure], ['mail.one.test', 587, 'mail.two.test', 465, null]);
  });
});

describe('Harvey contacts import', () => {
  it('suppresses opt-outs and invalid addresses, skips people already emailed, keeps verification', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg()));
    const csv = path.join(dir, 'contacts.csv');
    fs.writeFileSync(csv, [
      'email,first_name,last_name,company_name,title,website,linkedin_url,industry,personalization,email_status,score,seniority,source,status,created_at',
      'ann@shop1.test,Ann,Lee,Shop One,Owner,shop1.test,,restaurant,,verified,80,,sa_local,new,2026-11-12',
      'bob@shop2.test,Bob,,Shop Two,Owner,,,salon,,guess,50,,tx_notary,new,2026-11-12',
      'cat@shop3.test,Cat,,Shop Three,Owner,,,salon,,verified,50,,sa_local,opted_out,2026-11-12',
      'dan@shop4.test,Dan,,Shop Four,Owner,,,salon,,invalid,50,,sa_local,new,2026-11-12',
      'eve@shop5.test,Eve,,Shop Five,Owner,,,salon,,verified,50,,sa_local,contacted,2026-11-12',
      'fay@shop6.test,Fay,,Shop Six,Owner,,,salon,,verified,50,,sa_local,replied,2026-11-12', '',
    ].join('\n'));
    const r = JSON.parse(execFileSync(process.execPath, [path.join(__dirname, '..', 'bin', 'leonidas.js'), 'import-harvey-contacts', csv], { env: { ...process.env, LEONIDAS_HOME: dir }, encoding: 'utf8' }));
    assert.deepEqual(r, { added: 2, verified: 1, doNotContact: 2, leftOut: { 'already contacted in Harvey': 1, 'already replied in Harvey': 1 }, skipped: 0 });
    const { Leadwright } = require('../src/engine');
    const i = new Leadwright({ dir, cfg: cfg() });
    assert.deepEqual(i.leads().map(l => [l.email, l.name, l.company, l.verification]), [['ann@shop1.test', 'Ann Lee', 'Shop One', 'verified'], ['bob@shop2.test', 'Bob', 'Shop Two', 'guess']]);
    assert.ok(i.suppression.match('cat@shop3.test') && i.suppression.match('dan@shop4.test'));
  });
});

// self-signed cert for localhost, generated once with openssl
let KEY, CERT;
let haveOpenssl = true;
try {
  const d = tmp(); KEY = path.join(d, 'k.pem'); CERT = path.join(d, 'c.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', KEY, '-out', CERT, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' });
} catch { haveOpenssl = false; }

describe('mailbox pool over smtp (fake server in a child process)', { skip: !haveOpenssl && 'openssl not available' }, () => {
  let child, port, logFile;
  before(async () => {
    logFile = path.join(tmp(), 'msgs.json');
    const users = { 'a@acme.test': 'pw-a', 'b@acme.test': 'pw-b' };
    child = spawn(process.execPath, [path.join(__dirname, 'fake-smtp.js'), JSON.stringify({ mode: 'starttls', key: KEY, cert: CERT, log: logFile, users, limitRcpt: 'limited@' })]);
    port = await new Promise(res => child.stdout.on('data', d => { const m = String(d).match(/PORT (\d+)/); if (m) res(Number(m[1])); }));
  });
  after(() => { child.kill(); for (const k of ['LW_TEST_PW_A', 'LW_TEST_PW_B']) delete process.env[k]; });
  const inst = (pwB = 'pw-b') => {
    process.env.LW_TEST_PW_A = 'pw-a'; process.env.LW_TEST_PW_B = pwB;
    return lw({ over: { sending: { transport: 'smtp', smtp: { host: '127.0.0.1', port, caFile: CERT }, mailboxes: [{ email: 'a@acme.test', passwordEnv: 'LW_TEST_PW_A' }, { email: 'b@acme.test', passwordEnv: 'LW_TEST_PW_B' }] } } });
  };
  const sent = () => JSON.parse(fs.readFileSync(logFile, 'utf8'));

  it('logs in as each mailbox and sends from it', () => {
    const i = inst();
    [0, 1].forEach(n => queue(i, lead(n)));
    assert.deepEqual(i.sendApproved().map(x => x.status), ['sent', 'sent']);
    assert.deepEqual(sent().slice(-2).map(m => [m.authUser, m.from]), [['a@acme.test', 'a@acme.test'], ['b@acme.test', 'b@acme.test']]);
  });

  it('a mailbox whose login fails is skipped for the run; its message stays queued', () => {
    const before = sent().length;
    const i = inst('wrong');
    const ms = [0, 1, 2].map(n => queue(i, lead(n)));
    const r = i.sendApproved();
    assert.deepEqual(r.map(x => [x.status, x.mailbox]), [['sent', 'a@acme.test'], ['retry', 'b@acme.test'], ['sent', 'a@acme.test']]);
    assert.equal(i.outbox().find(x => x.id === ms[1].id).status, 'approved');
    assert.equal(i.bounces().length, 0);
    assert.equal(sent().length, before + 2);
  });

  it('a host sending limit is not recorded as a bounce', () => {
    const i = inst();
    const m = queue(i, { ...LEAD, email: 'limited@biz9.test' });
    const r = i.sendApproved()[0];
    assert.equal(r.status, 'retry');
    assert.equal(i.bounces().length, 0);
    assert.equal(i.suppression.match('limited@biz9.test'), null);
    assert.equal(i.outbox().find(x => x.id === m.id).status, 'approved');
  });

  it('mailboxes test logs in to each mailbox and sends nothing', () => {
    const i = inst('wrong');
    fs.writeFileSync(path.join(i.dir, 'config.json'), JSON.stringify(i.cfg));
    const before = sent().length;
    let stdout, code = 0;
    try { stdout = execFileSync(process.execPath, [path.join(__dirname, '..', 'bin', 'leonidas.js'), 'mailboxes', 'test', '--delay', '0'], { env: { ...process.env, LEONIDAS_HOME: i.dir }, encoding: 'utf8' }); } catch (e) { stdout = e.stdout; code = e.status; }
    assert.equal(code, 1);
    assert.match(stdout, /^ok {4}a@acme\.test .*encrypted\)$/m);
    assert.match(stdout, /^FAIL {2}b@acme\.test .*535/m);
    assert.match(stdout, /1\/2 mailboxes can log in\. Nothing was sent\./);
    assert.equal(sent().length, before);
  });

  it('status shows a mailbox with a missing password', () => {
    const i = inst();
    delete process.env.LW_TEST_PW_B;
    const st = i.status();
    assert.match(st.mailboxes[1].problems.join(), /LW_TEST_PW_B/);
    assert.deepEqual(st.mailboxes[0].problems, []);
  });
});
