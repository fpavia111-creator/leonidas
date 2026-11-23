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
  it('personal mail providers get sending.perFreeMailDomainDailyCap when it is set', () => {
    const log = Array.from({ length: 3 }, (_, i) => ({ day: '2026-10-20', status: 'sent', to: `p${i}@gmail.com` }));
    assert.match(d.canSend(cfg({}), { sendLog: log, bounces: [], email: 'new@gmail.com', now }).reasons.join(), /per-domain cap reached for gmail\.com \(3\/3\)/);
    const c = cfg({ sending: { perFreeMailDomainDailyCap: 100 } });
    assert.doesNotMatch(d.canSend(c, { sendLog: log, bounces: [], email: 'new@gmail.com', now }).reasons.join(), /per-domain/);
    const big = Array.from({ length: 100 }, (_, i) => ({ day: '2026-10-20', status: 'sent', to: `p${i}@gmail.com` }));
    assert.match(d.canSend(c, { sendLog: big, bounces: [], email: 'new@gmail.com', now }).reasons.join(), /gmail\.com \(100\/100, sending\.perFreeMailDomainDailyCap\)/);
    const co = Array.from({ length: 3 }, (_, i) => ({ day: '2026-10-20', status: 'sent', to: `p${i}@acme.test` }));
    assert.match(d.canSend(c, { sendLog: co, bounces: [], email: 'new@acme.test', now }).reasons.join(), /per-domain cap reached for acme\.test \(3\/3\)/);
  });
  it('bounce breaker', () => {
    const c = cfg({ sending: { minSendsForBounceRate: 10 } });
    const log = Array.from({ length: 10 }, (_, i) => ({ day: '2026-10-01', status: 'sent', to: `a${i}@q.test` }));
    const r = d.canSend(c, { sendLog: log, bounces: [{ type: 'hard', email: 'a3@q.test' }], email: 'b@r.test', now });
    assert.match(r.reasons.join(), /paused/);
  });
  it('bounce breaker ignores bounces for addresses Leonidas never sent to (imported history)', () => {
    const c = cfg({ sending: { minSendsForBounceRate: 10 } });
    const log = Array.from({ length: 10 }, (_, i) => ({ day: '2026-10-01', status: 'sent', to: `a${i}@q.test` }));
    const old = Array.from({ length: 189 }, (_, i) => ({ type: 'hard', email: `old${i}@x.test` }));
    assert.deepEqual(d.bounceStats(log, old), { sent: 10, hardBounces: 0, rate: 0 });
    assert.doesNotMatch(d.canSend(c, { sendLog: log, bounces: old, email: 'b@r.test', now }).reasons.join(), /paused/);
    assert.equal(d.bounceStats(log, [...old, { type: 'hard', email: 'A1@q.test' }]).hardBounces, 1);
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
    const ok = await d.checkDomainAuth('acme.test', { resolver, fetchImpl: null });
    assert.deepEqual(ok.problems, []);
    const bad = await d.checkDomainAuth('none.test', { resolver, dkimSelector: 's1', fetchImpl: null });
    assert.equal(bad.problems.length, 3);
  });
  it('dns check flags a newly registered domain', async () => {
    const resolver = { resolveTxt: async n => n === 'acme.test' ? [['v=spf1 ~all']] : [['v=DMARC1; p=none']] };
    const rdap = registered => async url => {
      if (url === 'https://data.iana.org/rdap/dns.json') return { ok: true, json: async () => ({ services: [[['test', 'example'], ['https://rdap.registry.test/v1/']]] }) };
      assert.equal(url, 'https://rdap.registry.test/v1/domain/acme.test');
      return { ok: true, json: async () => ({ events: [{ eventAction: 'registration', eventDate: registered }] }) };
    };
    const now = new Date('2026-11-22T00:00:00Z');
    const young = await d.checkDomainAuth('acme.test', { resolver, fetchImpl: rdap('2026-11-01T00:00:00Z'), now });
    assert.equal(young.ageDays, 21);
    assert.match(young.problems.join(), /registered 21 days ago/);
    const old = await d.checkDomainAuth('acme.test', { resolver, fetchImpl: rdap('2020-01-01T00:00:00Z'), now });
    assert.deepEqual(old.problems, []);
    const down = await d.checkDomainAuth('acme.test', { resolver, fetchImpl: async () => { throw new Error('offline'); }, now });
    assert.equal(down.registered, null);
    assert.deepEqual(down.problems, []);
  });
});
