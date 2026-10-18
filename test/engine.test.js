'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { lw, LEAD, GOOD, TUE, SAT } = require('./helpers');
const { Leadwright } = require('../src/engine');
const { DEFAULTS } = require('../src/config');

function queued(inst, extra = {}) {
  const { added: [lead] } = inst.addLeads([LEAD]);
  return { lead, msg: inst.queueEmail({ leadId: lead.id, ...GOOD, why: 'HVAC owner, no online booking', ...extra }) };
}

describe('safe defaults', () => {
  it('defaults are draft mode + human-only approval', () => {
    assert.equal(DEFAULTS.sending.mode, 'draft');
    assert.equal(DEFAULTS.approval.required, true);
    assert.equal(DEFAULTS.approval.allowAgentApproval, false);
  });
  it('draft mode never delivers even when approved', () => {
    const inst = lw({ over: { sending: { mode: 'draft' } } });
    const { msg } = queued(inst);
    inst.approve(msg.id);
    const [r] = inst.sendApproved();
    assert.equal(r.status, 'held');
    assert.match(r.reasons.join(), /draft/);
    assert.equal(fs.existsSync(path.join(inst.dir, 'sent')), false);
  });
  it('agent cannot approve by default', () => {
    const inst = lw(); const { msg } = queued(inst);
    assert.throws(() => inst.approve(msg.id, { actor: 'agent' }), /human/);
  });
  it('agent can approve only when explicitly configured', () => {
    const inst = lw({ over: { approval: { allowAgentApproval: true } } }); const { msg } = queued(inst);
    assert.equal(inst.approve(msg.id, { actor: 'agent' }).status, 'approved');
  });
  it('unapproved mail is never sent', () => {
    const inst = lw(); queued(inst);
    assert.deepEqual(inst.sendApproved(), []);
  });
});

describe('pipeline', () => {
  it('queue -> approve -> send on Tuesday writes .eml with footer + List-Unsubscribe', () => {
    const inst = lw(); const { msg } = queued(inst);
    assert.equal(msg.status, 'pending_approval');
    inst.approve(msg.id, { note: 'looks good' });
    const [r] = inst.sendApproved();
    assert.equal(r.status, 'sent');
    const eml = fs.readFileSync(path.join(inst.dir, 'sent', `${msg.id}.eml`), 'utf8');
    assert.match(eml, /List-Unsubscribe: <mailto:unsub@acme.test/);
    assert.match(eml, /100 Main St/);
    assert.match(eml, /Subject: booking on your site/);
  });
  it('Saturday send is scheduled for next Tuesday, then sends on Tuesday', () => {
    const inst = lw({ now: SAT }); const { msg } = queued(inst);
    inst.approve(msg.id);
    const [r] = inst.sendApproved();
    assert.equal(r.status, 'scheduled'); assert.equal(r.sendAfter, '2026-10-20');
    assert.equal(inst.outbox()[0].status, 'scheduled');
    inst.setNow(new Date('2026-10-19T15:00:00Z')); // Monday: still waiting
    assert.equal(inst.sendApproved()[0].status, 'scheduled');
    inst.setNow(TUE);
    assert.equal(inst.sendApproved()[0].status, 'sent');
  });
  it('send day must be Tue/Wed in both the lead timezone and America/Chicago', () => {
    const inst = lw({ now: new Date('2026-10-20T03:00:00Z') }); // Mon night Chicago, Tue Tokyo
    const { added: [lead] } = inst.addLeads([{ ...LEAD, timezone: 'Asia/Tokyo' }]);
    const m = inst.queueEmail({ leadId: lead.id, ...GOOD, why: 'x' });
    inst.approve(m.id);
    const r = inst.sendApproved()[0];
    assert.equal(r.status, 'scheduled'); assert.equal(r.sendAfter, '2026-10-20');
    inst.setNow(new Date('2026-10-20T15:00:00Z')); // Tue in both
    assert.equal(inst.sendApproved()[0].status, 'sent');
  });
  it('long subject is blocked at queue time', () => {
    const inst = lw(); const { msg } = queued(inst, { subject: 'a thought about your booking flow' });
    assert.equal(msg.status, 'blocked');
    assert.match(msg.gate.errors.join(), /under 30/);
    assert.throws(() => inst.approve(msg.id), /not pending/);
  });
  it('body word limit: 99 queues, 100 is blocked at queue time', () => {
    const w = n => Array.from({ length: n }, (_, i) => 'w' + i).join(' ');
    const ok = queued(lw(), { body: w(99) }).msg;
    assert.equal(ok.status, 'pending_approval');
    const bad = queued(lw(), { body: w(100) }).msg;
    assert.equal(bad.status, 'blocked');
    assert.match(bad.gate.errors.join(), /under 100 words/);
  });
  it('body word limit is re-checked at send time', () => {
    const w = n => Array.from({ length: n }, (_, i) => 'w' + i).join(' ');
    const inst = lw(); const { msg } = queued(inst, { body: w(99) });
    inst.approve(msg.id);
    inst._update(msg.id, m => { m.body = w(100) + m.body.slice(m.body.indexOf('\n\n--')); });
    const r = inst.sendApproved()[0];
    assert.equal(r.status, 'held');
    assert.match(r.reasons.join(), /under 100 words/);
  });
  it('why is required', () => {
    const inst = lw(); const { added: [lead] } = inst.addLeads([LEAD]);
    assert.throws(() => inst.queueEmail({ leadId: lead.id, ...GOOD }), /why/);
  });
  it('daily cap holds second send', () => {
    const inst = lw({ over: { sending: { dailyCap: 1, perDomainDailyCap: 5 } } });
    const { added } = inst.addLeads([LEAD, { ...LEAD, email: 'b@other.test' }]);
    for (const l of added) inst.approve(inst.queueEmail({ leadId: l.id, ...GOOD, why: 'fit' }).id);
    const rs = inst.sendApproved();
    assert.deepEqual(rs.map(r => r.status), ['sent', 'held']);
  });
});

describe('do-not-contact + bounces', () => {
  it('suppressed leads are skipped on import (incl. +tag and domain)', () => {
    const inst = lw();
    inst.suppress('owner@cascadehvac.test');
    inst.suppress('blocked.test');
    const r = inst.addLeads([{ ...LEAD, email: 'Owner+x@CascadeHVAC.test' }, { ...LEAD, email: 'a@mail.blocked.test' }]);
    assert.equal(r.added.length, 0); assert.equal(r.skipped.length, 2);
  });
  it('suppress after queueing pulls the message', () => {
    const inst = lw(); const { msg } = queued(inst);
    inst.approve(msg.id);
    inst.suppress('cascadehvac.test', { reason: 'asked to stop' });
    assert.equal(inst.outbox()[0].status, 'blocked');
    assert.deepEqual(inst.sendApproved(), []);
  });
  it('hard bounce auto-suppresses, soft does not', () => {
    const inst = lw();
    assert.equal(inst.recordBounce({ email: 'x@y.test', code: '4.2.2', diagnostic: 'mailbox full' }).suppressed, false);
    assert.equal(inst.recordBounce({ email: 'x@y.test', code: '5.1.1' }).suppressed, true);
    assert.ok(inst.suppression.match('x@y.test'));
  });
  it('duplicate leads are skipped', () => {
    const inst = lw(); inst.addLeads([LEAD]);
    assert.equal(inst.addLeads([LEAD]).skipped[0].why, 'duplicate');
  });
});

describe('audit log', () => {
  it('records why for every step and verifies chain', () => {
    const inst = lw(); const { lead, msg } = queued(inst);
    inst.approve(msg.id); inst.sendApproved();
    const w = inst.why(lead.id);
    assert.deepEqual(w.trail.map(t => t.action), ['lead_added', 'queued', 'approved', 'sent']);
    assert.equal(w.trail[3].reason, 'HVAC owner, no online booking');
    assert.ok(w.lead.scoreReasons.some(r => /HVAC/.test(r)));
    assert.equal(inst.audit.verify().ok, true);
  });
  it('detects tampering', () => {
    const inst = lw(); queued(inst);
    const f = path.join(inst.dir, 'audit.jsonl');
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('HVAC owner', 'someone else'));
    assert.equal(inst.audit.verify().ok, false);
  });
  it('records require a reason', () => {
    const inst = lw(); assert.throws(() => inst.audit.record({ action: 'sent' }), /reason/);
  });
  it('status reports send window', () => {
    const s = lw({ now: SAT }).status();
    assert.equal(s.sendDayToday, false); assert.equal(s.nextSendDay, '2026-10-20');
  });
});

describe('command transport', () => {
  it('pipes the message to a command', () => {
    const inst = lw(); const out = path.join(inst.dir, 'piped.eml');
    inst.cfg.sending.transport = 'command';
    const script = path.join(inst.dir, 'cat.js');
    fs.writeFileSync(script, `require('fs').writeFileSync(${JSON.stringify(out)}, require('fs').readFileSync(0));`);
    inst.cfg.sending.command = `${process.execPath} ${script}`;
    const { msg } = queued(inst); inst.approve(msg.id);
    assert.equal(inst.sendApproved()[0].status, 'sent');
    assert.match(fs.readFileSync(out, 'utf8'), /X-Leadwright-Id/);
  });
});
