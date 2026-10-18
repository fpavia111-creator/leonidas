'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const d = require('../src/deliverability');
const { DEFAULTS } = require('../src/config');
const { cfg } = require('./helpers');

describe('Tue/Wed send window', () => {
  it('is the default config', () => {
    assert.deepEqual(DEFAULTS.sending.allowedDays, ['Tue', 'Wed']);
    assert.equal(DEFAULTS.sending.timezone, 'America/Chicago');
  });
  const c = cfg();
  const at = s => new Date(s);
  it('Tue and Wed allowed, others not (Chicago)', () => {
    assert.ok(d.isAllowedDay(c, at('2026-10-20T15:00:00Z'), 'America/Chicago'));
    assert.ok(d.isAllowedDay(c, at('2026-10-21T15:00:00Z'), 'America/Chicago'));
    for (const s of ['2026-10-19T15:00:00Z', '2026-10-22T15:00:00Z', '2026-10-23T15:00:00Z', '2026-10-17T15:00:00Z', '2026-10-18T15:00:00Z']) {
      assert.equal(d.isAllowedDay(c, at(s), 'America/Chicago'), false, s);
    }
  });
  it('timezone boundary: 03:00Z Wed is still Tue in Chicago', () => {
    assert.equal(d.weekdayIn(at('2026-10-21T03:00:00Z'), 'America/Chicago'), 'Tue');
    // 03:00Z Tue = Mon evening in Chicago -> not allowed, even though it is Tue in Tokyo
    assert.equal(d.isAllowedDay(c, at('2026-10-20T03:00:00Z'), 'America/Chicago'), false);
    assert.equal(d.isAllowedDay(c, at('2026-10-20T03:00:00Z'), 'Asia/Tokyo'), false);
    assert.equal(d.isAllowedDay(c, at('2026-10-20T15:00:00Z'), 'Asia/Tokyo'), true);
  });
  it('next allowed day from Thu..Mon is next Tue', () => {
    for (const s of ['2026-10-22T15:00:00Z', '2026-10-23T15:00:00Z', '2026-10-24T15:00:00Z', '2026-10-25T15:00:00Z', '2026-10-26T15:00:00Z']) {
      assert.equal(d.nextAllowedDay(c, at(s)), '2026-10-27', s);
    }
    assert.equal(d.nextAllowedDay(c, at('2026-10-21T15:00:00Z')), '2026-10-21');
  });
  it('canSend blocks off-days with sendAfter', () => {
    const r = d.canSend(c, { sendLog: [], bounces: [], email: 'a@b.test', now: at('2026-10-17T15:00:00Z') });
    assert.equal(r.ok, false); assert.equal(r.dayBlocked, true); assert.equal(r.sendAfter, '2026-10-20');
  });
  it('recipient Tue is not enough when it is Mon in America/Chicago', () => {
    const r = d.canSend(c, { sendLog: [], bounces: [], email: 'a@b.test', now: at('2026-10-20T03:00:00Z'), recipientTz: 'Asia/Tokyo' });
    assert.equal(r.dayBlocked, true);
    // Recipient Thu (Tokyo) while Chicago Wed -> blocked too
    const r2 = d.canSend(c, { sendLog: [], bounces: [], email: 'a@b.test', now: at('2026-10-22T03:00:00Z'), recipientTz: 'Asia/Tokyo' });
    assert.equal(r2.dayBlocked, true);
  });
});

describe('caps, warmup, bounces', () => {
  it('warmup ramps and is bounded by dailyCap', () => {
    const c = cfg({ sending: { dailyCap: 20, warmup: { enabled: true, startDate: '2026-10-01', startPerDay: 5, incrementPerDay: 3 } } });
    assert.equal(d.effectiveDailyCap(c, '2026-10-01'), 5);
    assert.equal(d.effectiveDailyCap(c, '2026-10-03'), 11);
    assert.equal(d.effectiveDailyCap(c, '2026-12-01'), 20);
  });
  const now = new Date('2026-10-20T15:00:00Z');
  it('daily cap', () => {
    const c = cfg({ sending: { dailyCap: 2, perDomainDailyCap: 10 } });
    const log = [1, 2].map(i => ({ day: '2026-10-20', status: 'sent', to: `x${i}@q.test` }));
    assert.match(d.canSend(c, { sendLog: log, bounces: [], email: 'z@r.test', now }).reasons.join(), /daily cap/);
  });
  it('per-domain cap', () => {
    const c = cfg({ sending: { perDomainDailyCap: 1 } });
    const r = d.canSend(c, { sendLog: [{ day: '2026-10-20', status: 'sent', to: 'a@q.test' }], bounces: [], email: 'b@q.test', now });
    assert.match(r.reasons.join(), /per-domain/);
  });
  it('bounce breaker', () => {
    const c = cfg({ sending: { minSendsForBounceRate: 10 } });
    const log = Array.from({ length: 10 }, (_, i) => ({ day: '2026-10-01', status: 'sent', to: `a${i}@q.test` }));
    const r = d.canSend(c, { sendLog: log, bounces: [{ type: 'hard' }], email: 'b@r.test', now });
    assert.match(r.reasons.join(), /paused/);
  });
  it('classifyBounce', () => {
    assert.equal(d.classifyBounce('5.1.1', ''), 'hard');
    assert.equal(d.classifyBounce('550', ''), 'hard');
    assert.equal(d.classifyBounce('4.2.2', 'mailbox full'), 'soft');
    assert.equal(d.classifyBounce('', 'user reported spam complaint'), 'complaint');
  });
  it('dns check with fake resolver', async () => {
    const recs = { 'acme.test': [['v=spf1 include:_spf.google.com ~all']], '_dmarc.acme.test': [['v=DMARC1; p=none']] };
    const resolver = { resolveTxt: async n => { if (recs[n]) return recs[n]; throw new Error('ENOTFOUND'); } };
    const ok = await d.checkDomainAuth('acme.test', { resolver });
    assert.deepEqual(ok.problems, []);
    const bad = await d.checkDomainAuth('none.test', { resolver, dkimSelector: 's1' });
    assert.equal(bad.problems.length, 3);
  });
});
