'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { lw, TUE } = require('./helpers');

const NOTIFY = { notify: { email: 'owner@acme.test', dailyAt: '07:00' } };
const sentFiles = inst => { const d = path.join(inst.dir, 'sent'); return fs.existsSync(d) ? fs.readdirSync(d).map(f => fs.readFileSync(path.join(d, f), 'utf8')) : []; };
const rec = (over = {}) => ({ id: 'in_' + Math.random().toString(36).slice(2), category: 'needs_reply', status: 'new', from: 'dana@cascade.test', fromName: 'Dana', account: 'kurt@acme.test', subject: 'Re: booking', text: 'Yes, tell me more.\n\nOn Tue, Kurt wrote:\n> old', receivedAt: TUE.toISOString(), reasons: [], ...over });

describe('owner notifications', () => {
  it('does nothing without notify.email', () => {
    const inst = lw();
    inst.store.writeJson('inbox.json', [rec()]);
    assert.deepEqual(inst.notifyOwner(), { replies: 0, summary: false, sent: [] });
    assert.equal(sentFiles(inst).length, 0);
  });

  it('emails new replies from people once, quoting their words without the quoted thread', () => {
    const inst = lw({ over: NOTIFY });
    inst.store.writeJson('inbox.json', [rec(), rec({ category: 'escalate', from: 'angry@x.test', text: 'Take me off or I call a lawyer.' }), rec({ category: 'bounce', from: 'mailer-daemon@x.test' }), rec({ category: 'auto_reply', from: 'ooo@x.test' })]);
    const r = inst.notifyOwner({ now: new Date('2026-10-20T11:00:00Z') }); // 06:00 CT, before dailyAt
    assert.equal(r.replies, 2); assert.equal(r.summary, false);
    const [eml] = sentFiles(inst);
    assert.match(eml, /^To: <owner@acme\.test>/m);
    assert.match(eml, /Subject: Leonidas: 2 new replies/);
    assert.match(eml, /Yes, tell me more\./);
    assert.doesNotMatch(eml, /> old/);
    assert.match(eml, /Needs you: Leonidas will not answer this one\./);
    assert.doesNotMatch(eml, /mailer-daemon|ooo@x/);
    assert.equal(inst.notifyOwner({ now: new Date('2026-10-20T11:05:00Z') }).replies, 0, 'each reply is reported once');
    assert.ok(inst.inboxRecords().filter(x => ['needs_reply', 'escalate'].includes(x.category)).every(x => x.notifiedAt));
  });

  it('sends the daily summary once a day, after dailyAt', () => {
    const inst = lw({ over: NOTIFY });
    inst.store.writeJson('inbox.json', [rec({ receivedAt: '2026-10-19T18:00:00Z', notifiedAt: 'x' }), rec({ category: 'bounce', receivedAt: '2026-10-19T19:00:00Z' })]);
    inst.store.append('sends.jsonl', { id: 'm1', to: 'a@b.test', day: '2026-10-19', ts: '2026-10-19T16:00:00Z', status: 'sent' });
    assert.equal(inst.notifyOwner({ now: new Date('2026-10-20T11:30:00Z') }).summary, false, '06:30 CT is before 07:00');
    const r = inst.notifyOwner({ now: new Date('2026-10-20T12:30:00Z') });
    assert.equal(r.summary, true);
    const eml = sentFiles(inst).find(e => /Leonidas daily/.test(e));
    assert.match(eml, /Subject: Leonidas daily: 1 sent, 1 replies/);
    assert.match(eml, /Bounces: 1/);
    assert.equal(inst.notifyOwner({ now: new Date('2026-10-20T20:00:00Z') }).summary, false, 'once per day');
    assert.equal(inst.notifyOwner({ now: new Date('2026-10-21T12:30:00Z') }).summary, true, 'and again the next day');
  });
});
