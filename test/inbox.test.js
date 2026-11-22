'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const { fetchRecent, parseMessage, ownWords, decodeWords } = require('../src/imap');
const { classify } = require('../src/inbox');
const { validateConfig, DEFAULTS, deepMerge } = require('../src/config');
const { lw, LEAD, GOOD, SAT } = require('./helpers');

const ENV = { LEONIDAS_IMAP_PASSWORD: 'secret' };

/** Tiny fake IMAP server (plaintext, tests only). messages: [{uid, raw}]; spam: messages in INBOX.spam */
function fakeImap(inboxMessages, { user = 'me@acme.test', pass = 'secret', spam = null } = {}) {
  const commands = [];
  let messages = inboxMessages;
  const server = net.createServer(sock => {
    sock.setEncoding('latin1');
    let buf = '';
    sock.write('* OK fake IMAP ready\r\n');
    sock.on('data', d => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        const [tag, verb, ...rest] = line.split(' ');
        commands.push(verb === 'LOGIN' ? 'LOGIN [hidden]' : line.slice(tag.length + 1));
        const V = (verb || '').toUpperCase();
        if (V === 'LOGIN') { const ok = rest.join(' ') === `"${user}" "${pass}"`; sock.write(ok ? `${tag} OK logged in\r\n` : `${tag} NO [AUTHENTICATIONFAILED] bad\r\n`); }
        else if (V === 'LIST') sock.write(`* LIST (\\HasNoChildren) "." "INBOX"\r\n${spam ? '* LIST (\\HasNoChildren \\Junk) "." "INBOX.spam"\r\n' : ''}* LIST (\\HasNoChildren) "." "INBOX.Sent"\r\n${tag} OK done\r\n`);
        else if (V === 'EXAMINE') {
          const box = rest.join(' ').replace(/"/g, '');
          if (box === 'INBOX.spam' && spam) { messages = spam; sock.write(`* OK [UIDVALIDITY 77] ok\r\n${tag} OK [READ-ONLY] done\r\n`); }
          else if (box === 'INBOX') { messages = inboxMessages; sock.write(`* ${messages.length} EXISTS\r\n* OK [UIDVALIDITY 42] ok\r\n${tag} OK [READ-ONLY] done\r\n`); }
          else sock.write(`${tag} NO no such folder\r\n`);
        }
        else if (V === 'UID' && /^SEARCH/i.test(rest[0])) sock.write(`* SEARCH ${messages.map(m => m.uid).join(' ')}\r\n${tag} OK done\r\n`);
        else if (V === 'UID' && /^FETCH/i.test(rest[0])) {
          const want = rest[1].split(',').map(Number);
          messages.filter(m => want.includes(m.uid)).forEach((m, n) => {
            const sep = m.raw.indexOf('\r\n\r\n');
            const header = m.raw.slice(0, sep + 4), text = m.raw.slice(sep + 4);
            sock.write(`* ${n + 1} FETCH (UID ${m.uid} INTERNALDATE "21-Nov-2026 10:00:00 +0000" BODY[HEADER] {${Buffer.byteLength(header, 'latin1')}}\r\n${header} BODY[TEXT]<0> {${Buffer.byteLength(text, 'latin1')}}\r\n${text})\r\n`);
          });
          sock.write(`${tag} OK done\r\n`);
        } else if (V === 'LOGOUT') { sock.write(`* BYE\r\n${tag} OK bye\r\n`); sock.end(); }
        else sock.write(`${tag} BAD unknown\r\n`);
      }
    });
    sock.on('error', () => {});
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ port: server.address().port, commands, close: () => server.close() })));
}

const eml = (headers, body) => Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n\r\n' + body.replace(/\r?\n/g, '\r\n');
const acct = port => ({ host: '127.0.0.1', port, user: 'me@acme.test', allowPlaintext: true });

describe('imap client (fake server)', () => {
  it('logs in read-only, fetches with PEEK and skips what it has seen', async () => {
    const s = await fakeImap([
      { uid: 7, raw: eml({ From: 'Dana <owner@cascadehvac.test>', To: 'kurt@acme.test', Subject: 'Re: booking', 'Message-ID': '<a1@x.test>' }, 'Yes, tell me more.\r\n\r\nOn Tue, Kurt wrote:\r\n> old text') },
      { uid: 9, raw: eml({ From: 'b@y.test', To: 'kurt@acme.test', Subject: 'hi' }, 'second') },
    ]);
    try {
      const r = await fetchRecent(acct(s.port), { since: new Date('2026-11-14'), skip: new Set(['42:9']), env: ENV });
      assert.equal(r.uidValidity, '42');
      assert.deepEqual(r.messages.map(m => m.key), ['42:7']);
      const m = parseMessage(r.messages[0]);
      assert.equal(m.from.email, 'owner@cascadehvac.test');
      assert.equal(m.own, 'Yes, tell me more.');
      assert.equal(m.messageId, '<a1@x.test>');
      assert.ok(s.commands.some(c => /^EXAMINE "INBOX"/.test(c)), 'opens the mailbox read-only');
      assert.ok(s.commands.some(c => /BODY\.PEEK\[HEADER\]/.test(c)), 'never marks mail as read');
      assert.ok(s.commands.includes('UID SEARCH SINCE 14-Nov-2026'));
    } finally { s.close(); }
  });
  it('also checks the spam folder, keyed separately', async () => {
    const s = await fakeImap([{ uid: 1, raw: eml({ From: 'a@x.test', Subject: 'in inbox' }, 'hi') }],
      { spam: [{ uid: 1, raw: eml({ From: 'lead@x.test', Subject: 'landed in spam' }, 'Is this still available?') }] });
    try {
      const r = await fetchRecent(acct(s.port), { env: ENV });
      assert.deepEqual(r.folders, ['INBOX', 'INBOX.spam']);
      assert.deepEqual(r.messages.map(m => `${m.folder} ${m.key}`), ['INBOX 42:1', 'INBOX.spam INBOX.spam/77:1']);
      const only = await fetchRecent({ ...acct(s.port), checkSpam: false }, { env: ENV });
      assert.deepEqual(only.folders, ['INBOX']);
    } finally { s.close(); }
  });
  it('wrong password fails with a clear error and no password in it', async () => {
    const s = await fakeImap([]);
    try {
      await assert.rejects(fetchRecent(acct(s.port), { env: { LEONIDAS_IMAP_PASSWORD: 'nope' } }), e => /LOGIN failed/.test(e.message) && !/nope/.test(e.message));
    } finally { s.close(); }
  });
  it('refuses to run without the password variable', async () => {
    await assert.rejects(fetchRecent(acct(1), { env: {} }), /LEONIDAS_IMAP_PASSWORD is not set/);
  });
});

describe('MIME decoding', () => {
  it('decodes encoded-word subjects and quoted-printable / base64 bodies', () => {
    assert.equal(decodeWords('=?UTF-8?B?Q2Fmw6k=?= =?UTF-8?Q?_ma=C3=B1ana?='), 'Café mañana');
    const m = parseMessage({ header: 'From: a@b.test\r\nSubject: x\r\nContent-Type: multipart/alternative; boundary="BB"\r\n\r\n', text: '--BB\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nPrecio por p=C3=A1gina?\r\n--BB\r\nContent-Type: text/html\r\n\r\n<p>ignored</p>\r\n--BB--\r\n' });
    assert.equal(m.own, 'Precio por página?');
    const h = parseMessage({ header: 'From: a@b.test\r\nContent-Type: text/html\r\nContent-Transfer-Encoding: base64\r\n\r\n', text: Buffer.from('<div>Call me <b>today</b></div>').toString('base64') });
    assert.equal(h.own, 'Call me today');
  });
  it('drops quoted history in its common shapes', () => {
    assert.equal(ownWords('Sounds good\n\n-----Original Message-----\nFrom: x'), 'Sounds good');
    assert.equal(ownWords('Ok\nOn Mon, Nov 17, 2026 at 9:00 AM Kurt <k@a.test>\nwrote:\n> hi'), 'Ok');
    assert.equal(ownWords('Sure\nFrom: Kurt\nSent: Monday\nhello'), 'Sure');
  });
});

const msg = (over = {}) => ({ from: { email: 'dana@shop.test', name: 'Dana' }, subject: 'Re: booking', headers: {}, body: '', own: '', attachments: [], dsn: '', recipients: [], ...over });
const cat = (over, ctx) => classify(msg(over), ctx).category;

describe('sorting incoming mail', () => {
  it('opt-outs (Harvey phrases, bare STOP, no thanks) are never answered', () => {
    assert.equal(cat({ own: 'Please remove me from your list' }), 'opt_out');
    assert.equal(cat({ own: 'STOP' }), 'opt_out');
    assert.equal(cat({ own: 'no thanks\n\nSent from my iPhone' }), 'opt_out');
    assert.equal(cat({ own: 'Not interested.' }), 'opt_out');
    assert.equal(cat({ own: 'Por favor dar de baja' }), 'opt_out');
    assert.equal(cat({ own: 'Yes or no, thanks for asking: how much is it?' }), 'needs_reply');
  });
  it('legal / angry mail goes to a human', () => {
    assert.equal(cat({ own: 'My attorney will hear about this' }), 'escalate');
    assert.equal(cat({ own: 'This is harassment, I am reporting you to the FTC' }), 'escalate');
  });
  it('phishing and SEO spam are never answered', () => {
    assert.equal(cat({ subject: 'I placed an order', own: 'Please review the attached document and confirm.' }), 'suspicious');
    assert.equal(cat({ own: 'We can get your website on the first page of Google' }), 'suspicious');
    assert.equal(cat({ own: 'see file', attachments: [{ name: 'invoice.html' }] }), 'suspicious');
  });
  it('bounces, auto-replies, newsletters and our own mail are not conversations', () => {
    const b = classify(msg({ from: { email: 'mailer-daemon@mx.test' }, subject: 'Undeliverable: hello', body: 'Final-Recipient: rfc822; gone@lost.test\nStatus: 5.1.1\nDiagnostic-Code: smtp; 550 5.1.1 user unknown' }));
    assert.equal(b.category, 'bounce'); assert.equal(b.bounce.recipient, 'gone@lost.test'); assert.equal(b.bounce.code, '5.1.1');
    assert.equal(cat({ subject: 'Out of Office: back Monday' }), 'auto_reply');
    assert.equal(cat({ headers: { 'list-unsubscribe': ['<mailto:x@y>'] }, own: 'Our November deals' }), 'automated');
    assert.equal(cat({ from: { email: 'noreply@stripe.test' }, own: 'Receipt' }), 'automated');
    assert.equal(cat({ from: { email: 'kurt@acme.test' } }, { ownAddresses: new Set(['kurt@acme.test']) }), 'own');
  });
  it('booking systems, cPanel notices and our own domains are never answered', () => {
    assert.equal(cat({ from: { email: 'bookings@bufo.test' }, own: 'New booking: Tuesday' }), 'automated');
    assert.equal(cat({ from: { email: 'cpanel@g6.test' }, own: 'Client configuration settings' }), 'automated');
    assert.equal(cat({ from: { email: 'leads@g6.test' }, own: 'New lead' }, { ownDomains: new Set(['g6.test']) }), 'own');
  });
  it('a person writing is a reply candidate; info@ addresses count as people', () => {
    const c = classify(msg({ from: { email: 'info@smallshop.test' }, own: 'How much for a 5 page site?' }));
    assert.equal(c.category, 'needs_reply'); assert.equal(c.autoReplyEligible, true);
    const s = classify(msg({ own: 'hello again' }), { isSuppressed: () => ({ value: 'dana@shop.test' }) });
    assert.equal(s.autoReplyEligible, false);
  });
});

/** A fetch stub that serves raw messages once each. */
const stub = raws => async (a, { skip }) => ({ uidValidity: '1', messages: raws.map((raw, i) => ({ key: `1:${i + 1}`, uid: i + 1, ...splitRaw(raw) })).filter(m => !skip.has(m.key)) });
const splitRaw = raw => { const i = raw.indexOf('\r\n\r\n'); return { header: raw.slice(0, i + 4), text: raw.slice(i + 4) }; };
const INBOX = { inbox: { accounts: [{ host: 'imap.test', user: 'kurt@acme.test' }] } };

describe('engine: checking the inbox and replying', () => {
  it('suppresses opt-outs, records bounces, pulls a replying lead\'s cold mail, and dedupes', async () => {
    const inst = lw({ over: INBOX });
    const { added: [lead] } = inst.addLeads([LEAD]);
    const cold = inst.queueEmail({ leadId: lead.id, ...GOOD, why: 'test' });
    const fetch = stub([
      eml({ From: 'Dana <owner@cascadehvac.test>', To: 'kurt@acme.test', Subject: 'Re: booking on your site', 'Message-ID': '<r1@x.test>' }, 'How much does it cost?'),
      eml({ From: 'pat@other.test', To: 'kurt@acme.test', Subject: 'Re: hi' }, 'unsubscribe'),
      eml({ From: 'MAILER-DAEMON@mx.test', To: 'kurt@acme.test', Subject: 'Undeliverable' }, 'Final-Recipient: rfc822; gone@lost.test\nStatus: 5.1.1\nuser unknown'),
    ]);
    const r = await inst.checkInbox({ env: ENV, fetch });
    assert.deepEqual(r.new.map(m => m.category), ['needs_reply', 'opt_out', 'bounce']);
    assert.ok(inst.suppression.match('pat@other.test'));
    assert.ok(inst.suppression.match('gone@lost.test'));
    assert.equal(inst.outbox().find(m => m.id === cold.id).status, 'blocked');
    assert.equal(inst.getLead(lead.id).status, 'replied');
    const again = await inst.checkInbox({ env: ENV, fetch });
    assert.equal(again.new.length, 0);
  });

  it('autoReply off (default): the agent\'s reply waits for a human, threaded on their message', async () => {
    const inst = lw({ over: INBOX });
    await inst.checkInbox({ env: ENV, fetch: stub([eml({ From: 'Lee <lee@shop.test>', To: 'kurt@acme.test', Subject: 'Website price?', 'Message-ID': '<q1@shop.test>' }, 'What do you charge for a site?')]) });
    const [rec] = inst.inbox({ status: 'new' });
    const r = inst.queueReply({ inboxId: rec.id, body: 'Sites start at $500. Want me to send two examples?', intent: 'question' });
    assert.equal(r.autoSent, false);
    assert.equal(r.message.status, 'pending_approval');
    assert.equal(r.message.subject, 'Re: Website price?');
    assert.equal(r.message.inReplyTo, '<q1@shop.test>');
    inst.approve(r.message.id);
    const [s] = inst.sendApproved();
    assert.equal(s.status, 'sent');
    assert.equal(inst.inboxRecords()[0].status, 'replied');
    const fs = require('fs'); const path = require('path');
    const out = fs.readFileSync(path.join(inst.dir, 'sent', `${r.message.id}.eml`), 'utf8');
    assert.match(out, /In-Reply-To: <q1@shop\.test>/);
  });

  it('autoReply on: sends at once, even on a Saturday, but only to eligible people with safe intents', async () => {
    const inst = lw({ now: SAT, over: { ...INBOX, inbox: { ...INBOX.inbox, autoReply: true, autoReplyTo: 'people' } } });
    await inst.checkInbox({ env: ENV, fetch: stub([
      eml({ From: 'lee@shop.test', To: 'kurt@acme.test', Subject: 'Website price?', 'Message-ID': '<q1@shop.test>' }, 'What do you charge?'),
      eml({ From: 'sam@shop2.test', To: 'kurt@acme.test', Subject: 'hello' }, 'Can we talk?'),
      eml({ From: 'angry@x.test', To: 'kurt@acme.test', Subject: 'stop' }, 'My lawyer will call you.'),
    ]) });
    const [q, sam, angry] = inst.inboxRecords();
    const sent = inst.queueReply({ inboxId: q.id, body: 'Sites start at $500. Want two examples?', intent: 'question' });
    assert.equal(sent.autoSent, true, JSON.stringify(sent.why || sent.result));
    assert.equal(sent.message.approvedBy, 'auto-reply');
    const other = inst.queueReply({ inboxId: sam.id, body: 'Sure, what time works?', intent: 'other' });
    assert.equal(other.autoSent, false, 'intent "other" waits for a human');
    assert.throws(() => inst.queueReply({ inboxId: angry.id, body: 'Sorry!', intent: 'question' }), /never replies/);
    assert.throws(() => inst.queueReply({ inboxId: q.id, body: 'again', intent: 'question' }), /already/);
  });

  it('autoReplyTo "leads" (default) keeps strangers waiting for a human', async () => {
    const inst = lw({ over: { ...INBOX, inbox: { ...INBOX.inbox, autoReply: true } } });
    await inst.checkInbox({ env: ENV, fetch: stub([eml({ From: 'lee@shop.test', To: 'kurt@acme.test', Subject: 'price' }, 'How much?')]) });
    const r = inst.queueReply({ inboxId: inst.inboxRecords()[0].id, body: 'From $500. Want examples?', intent: 'question' });
    assert.equal(r.autoSent, false);
    assert.ok(r.why.some(w => /not a lead/.test(w)));
  });

  it('daily auto-reply limit and the per-person loop guard', async () => {
    const inst = lw({ over: { ...INBOX, inbox: { ...INBOX.inbox, autoReply: true, autoReplyTo: 'people', maxAutoRepliesPerDay: 1 } } });
    await inst.checkInbox({ env: ENV, fetch: stub([
      eml({ From: 'a@one.test', To: 'kurt@acme.test', Subject: 'q1' }, 'price?'),
      eml({ From: 'b@two.test', To: 'kurt@acme.test', Subject: 'q2' }, 'price?'),
    ]) });
    const [a, b] = inst.inboxRecords();
    assert.equal(inst.queueReply({ inboxId: a.id, body: 'From $500.', intent: 'question' }).autoSent, true);
    const r = inst.queueReply({ inboxId: b.id, body: 'From $500.', intent: 'question' });
    assert.equal(r.autoSent, false);
    assert.ok(r.why.some(w => /daily auto-reply limit/.test(w)));
  });

  it('a reply goes out from the pooled mailbox the person wrote to', async () => {
    const inst = lw({ over: { ...INBOX, sending: { mailboxes: ['one@acme.test', 'two@acme.test'] } } });
    await inst.checkInbox({ env: ENV, fetch: stub([eml({ From: 'lee@shop.test', To: 'two@acme.test', 'Delivered-To': 'kurt@acme.test', Subject: 'hi' }, 'Do you build stores?')]) });
    const r = inst.queueReply({ inboxId: inst.inboxRecords()[0].id, body: 'Yes. Want an example?', intent: 'question' });
    inst.approve(r.message.id);
    const [s] = inst.sendApproved();
    assert.equal(s.mailbox, 'two@acme.test');
  });
});

describe('inbox config', () => {
  it('rejects a password in the file and warns when auto-reply is on', () => {
    const v = validateConfig(deepMerge(DEFAULTS, { inbox: { accounts: [{ host: 'h', user: 'u', password: 'x' }], autoReply: true } }));
    assert.ok(v.errors.some(e => /password must not be stored/.test(e)));
    assert.ok(v.warnings.some(w => /autoReply is true/.test(w)));
  });
  it('defaults: auto-reply off, leads only', () => {
    assert.equal(DEFAULTS.inbox.autoReply, false);
    assert.equal(DEFAULTS.inbox.autoReplyTo, 'leads');
  });
});
