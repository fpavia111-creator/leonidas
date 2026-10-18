'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const yaml = require('../src/yaml');
const { fromHarvey, parseDurationMinutes, normalizeCompanySize } = require('../src/harvey');
const { DEFAULTS, deepMerge, loadConfig, validateConfig } = require('../src/config');
const d = require('../src/deliverability');
const { matchObjection } = require('../src/objections');
const { writerPrompt, pickBenefits } = require('../src/prompts');
const { cfg, lw, tmp, LEAD, GOOD, TUE } = require('./helpers');

const SAMPLE = `persona:
  name: Pat
  company: Example Co
  email: pat@example.test
  postal_address: 1 Example Way, Springfield, IL 62701
product:
  name: Widgets
  description: We make widgets for
    local shops, quickly.
  pricing: 'Basic: $10. Pro: $20 (it''s popular).'
  key_benefits:
  - Save time on booking
  - Cheaper than an agency
  objection_responses:
    "Too expensive?": "Basic is $10. What budget did you have in mind?"
    "Can I think about it?": "Of course. What would you still need to know?"
  offer:
    entry: 'Basic: $10'
    goal: get_reply
    booking_method: ask_preference
    meeting_duration: 10 minutes
icp:
  industries:
    - salon
  company_size: 1-20 employees
channels:
  email:
    max_daily_sends: 20
    send_unverified: false
    personalize_first_email: false
    personalize_first_email: true # duplicate
    require_approval: true
    max_bounce_rate: 0.02
    send_interval_seconds: 180
    send_window_start: '09:00'
    send_window_end: '13:00'
    send_days:
      - mon
      - tue
      - wed
    send_ramp:
      - 5
      - 10
      - 20
usage:
  max_daily_claude_percent: 40
  quiet_hours:
    start: '22:00'
    end: 07:00
    timezone: America/Chicago
brain:
  provider: claude
`;

describe('yaml subset', () => {
  const r = yaml.parse(SAMPLE);
  it('parses nested maps, lists, quoted keys, folded and escaped scalars', () => {
    assert.equal(r.value.product.description, 'We make widgets for local shops, quickly.');
    assert.equal(r.value.product.pricing, "Basic: $10. Pro: $20 (it's popular).");
    assert.equal(r.value.product.objection_responses['Too expensive?'], 'Basic is $10. What budget did you have in mind?');
    assert.deepEqual(r.value.channels.email.send_ramp, [5, 10, 20]);
    assert.equal(r.value.usage.quiet_hours.end, '07:00');
    assert.equal(r.value.channels.email.max_bounce_rate, 0.02);
  });
  it('reports duplicate keys, last wins', () => {
    assert.equal(r.value.channels.email.personalize_first_email, true);
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0].message, /duplicate key "channels.email.personalize_first_email"/);
  });
  it('round-trips through stringify', () => {
    assert.deepEqual(yaml.parse(yaml.stringify(r.value)).value, r.value);
    const odd = { a: ['- x', 'true', '12', '', 'a: b', '#c', "it's"], 'k: y': { n: null, b: false } };
    assert.deepEqual(yaml.parse(yaml.stringify(odd)).value, odd);
  });
  it('rejects unsupported syntax', () => {
    assert.throws(() => yaml.parse('a: &x 1\n'), /unsupported/);
    assert.throws(() => yaml.parse('a: |\n  b\n'), /unsupported/);
  });
});

describe('harvey import + schema', () => {
  const { config, notes } = fromHarvey(yaml.parse(SAMPLE).value);
  const full = deepMerge(DEFAULTS, config);
  it('maps every section', () => {
    assert.equal(full.sender.physicalAddress, '1 Example Way, Springfield, IL 62701');
    assert.equal(full.sending.dailyCap, 20);
    assert.deepEqual(full.sending.ramp, [5, 10, 20]);
    assert.equal(full.sending.sendUnverified, false);
    assert.equal(full.sending.minIntervalSeconds, 180);
    assert.deepEqual(full.sending.window, { start: '09:00', end: '13:00' });
    assert.equal(full.approval.required, true);
    assert.equal(full.offer.bookingMethod, 'ask_preference');
    assert.equal(full.offer.meetingDurationMinutes, 10);
    assert.equal(full.icp.companySize, '1-20');
    assert.equal(full.usage.maxDailyBrainPercent, 40);
    assert.equal(full.sending.mode, 'draft');
    assert.equal(Object.keys(full.product.objectionResponses).length, 2);
    assert.ok(notes.some(n => /meetingDurationMinutes 10/.test(n)));
  });
  it('validates clean, and flags Mon in send days', () => {
    const v = validateConfig(full);
    assert.deepEqual(v.errors, []);
    assert.ok(v.warnings.some(w => /mon/.test(w)));
  });
  it('validation catches bad values', () => {
    const bad = deepMerge(full, { offer: { bookingMethod: 'link', meetingDurationMinutes: 0 }, sending: { ramp: ['x'], window: { start: '9am' } }, usage: { maxDailyBrainPercent: 140 } });
    const e = validateConfig(bad).errors.join('\n');
    for (const re of [/bookingUrl/, /meetingDurationMinutes/, /ramp/, /window.start/, /maxDailyBrainPercent/]) assert.match(e, re);
  });
  it('duration / size helpers', () => {
    assert.equal(parseDurationMinutes('10 minutes'), 10);
    assert.equal(parseDurationMinutes('1 hour'), 60);
    assert.equal(parseDurationMinutes(15), 15);
    assert.equal(parseDurationMinutes('soon'), null);
    assert.equal(normalizeCompanySize('1-10,000 employees'), '1-10000');
  });
  it('loadConfig reads config.yaml from the state dir', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'config.yaml'), yaml.stringify(config));
    const c = loadConfig(dir);
    assert.equal(c.sending.dailyCap, 20);
    assert.equal(c.compliance.maxSubjectLength, 29); // defaults still merged
  });
});

describe('sending controls', () => {
  it('ramp: 5, 10, 20 then dailyCap', () => {
    const c = cfg({ sending: { dailyCap: 20, ramp: [5, 10, 20], warmup: { enabled: true, startDate: '2026-10-20' } } });
    assert.equal(d.effectiveDailyCap(c, '2026-10-20'), 5);
    assert.equal(d.effectiveDailyCap(c, '2026-10-21'), 10);
    assert.equal(d.effectiveDailyCap(c, '2026-10-22'), 20);
    assert.equal(d.effectiveDailyCap(c, '2026-12-01'), 20);
    const c2 = cfg({ sending: { dailyCap: 8, ramp: [5, 10, 20], warmup: { enabled: true, startDate: '2026-10-20' } } });
    assert.equal(d.effectiveDailyCap(c2, '2026-10-21'), 8);
  });
  it('allowedDays can narrow Tue/Wed but never widen', () => {
    assert.deepEqual(d.allowedDays(cfg({ sending: { allowedDays: ['mon', 'tue', 'wed', 'thu'] } })), ['Tue', 'Wed']);
    assert.deepEqual(d.allowedDays(cfg({ sending: { allowedDays: ['Wed'] } })), ['Wed']);
    assert.deepEqual(d.allowedDays(cfg({ sending: { allowedDays: ['Fri'] } })), ['Tue', 'Wed']);
    const c = cfg({ sending: { allowedDays: ['Mon', 'Thu'] } });
    assert.equal(d.isAllowedDay(c, new Date('2026-10-19T15:00:00Z'), 'America/Chicago'), false);
  });
  it('send window in sender timezone', () => {
    const c = cfg({ sending: { window: { start: '09:00', end: '13:00' } } });
    assert.equal(d.canSend(c, { sendLog: [], bounces: [], email: 'a@b.test', now: new Date('2026-10-20T15:00:00Z') }).ok, true); // 10:00 CT
    const late = d.canSend(c, { sendLog: [], bounces: [], email: 'a@b.test', now: new Date('2026-10-20T19:30:00Z') }); // 14:30 CT
    assert.equal(late.ok, false); assert.match(late.reasons.join(), /send window/);
  });
  it('quiet hours wrap midnight', () => {
    const c = cfg({ usage: { quietHours: { start: '22:00', end: '07:00', timezone: 'America/Chicago' } } });
    assert.equal(d.isQuietHours(c, new Date('2026-10-21T04:00:00Z')), true);  // 23:00 CT
    assert.equal(d.isQuietHours(c, new Date('2026-10-20T11:30:00Z')), true);  // 06:30 CT
    assert.equal(d.isQuietHours(c, new Date('2026-10-20T15:00:00Z')), false); // 10:00 CT
  });
  it('min interval between sends', () => {
    const c = cfg({ sending: { minIntervalSeconds: 180 } });
    const log = [{ status: 'sent', day: '2026-10-20', to: 'x@y.test', ts: new Date(TUE.getTime() - 60000).toISOString() }];
    const r = d.canSend(c, { sendLog: log, bounces: [], email: 'a@b.test', now: TUE });
    assert.equal(r.ok, false); assert.match(r.reasons.join(), /send interval/);
    assert.equal(d.canSend(c, { sendLog: log, bounces: [], email: 'a@b.test', now: new Date(TUE.getTime() + 130000) }).ok, true);
  });
  it('unverified recipients are held unless sendUnverified', () => {
    const inst = lw();
    const { added: [lead] } = inst.addLeads([{ ...LEAD, emailVerified: false }]);
    const m = inst.queueEmail({ leadId: lead.id, ...GOOD, why: 'x' }); inst.approve(m.id);
    const r = inst.sendApproved()[0];
    assert.equal(r.status, 'held'); assert.match(r.reasons.join(), /not verified/);
    const inst2 = lw({ over: { sending: { sendUnverified: true } } });
    const { added: [l2] } = inst2.addLeads([{ ...LEAD, emailVerified: false }]);
    const m2 = inst2.queueEmail({ leadId: l2.id, ...GOOD, why: 'x' }); inst2.approve(m2.id);
    assert.equal(inst2.sendApproved()[0].status, 'sent');
  });
});

describe('sales context', () => {
  const map = { 'Too expensive?': 'R1', 'Can I keep my current domain?': 'R2' };
  it('matches objections by overlap, null when unrelated', () => {
    assert.equal(matchObjection(map, 'can i keep the domain i already have').response, 'R2');
    assert.equal(matchObjection(map, 'it is too expensive for us').response, 'R1');
    assert.equal(matchObjection(map, 'banana'), null);
  });
  it('writer prompt carries offer, booking preference and personalization', () => {
    const c = cfg({ offer: { entry: 'Basic $10', bookingMethod: 'ask_preference', meetingDurationMinutes: 10, meetingOwner: 'Pat' }, product: { keyBenefits: ['Fast setup', 'Online booking for customers'] }, sender: { tone: 'Friendly' } });
    const p = writerPrompt({ lead: LEAD, icp: { id: 'x' }, sender: c.sender, cfg: c });
    assert.match(p, /Entry offer to mention: Basic \$10/);
    assert.match(p, /do NOT include a booking link/);
    assert.match(p, /10-minute call with Pat/);
    assert.match(p, /Tone: Friendly/);
    assert.match(p, /Personalize/);
    assert.equal(pickBenefits(c.product.keyBenefits, LEAD, 1)[0], 'Online booking for customers');
  });
});

describe('examples/', () => {
  it('local-web-agency.yaml loads, validates and is draft + approval + verified-only', () => {
    const c = loadConfig('/nonexistent', path.join(__dirname, '..', 'examples', 'local-web-agency.yaml'));
    assert.deepEqual(validateConfig(c).errors, []);
    assert.equal(c.sending.mode, 'draft'); assert.equal(c.approval.required, true); assert.equal(c.sending.sendUnverified, false);
    assert.equal(c.sending.transport, 'smtp'); assert.ok(!('password' in c.sending.smtp));
    assert.ok(Object.keys(c.product.objectionResponses).length >= 15);
  });
});
