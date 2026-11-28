'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { lw, LEAD, GOOD } = require('./helpers');
const d = require('../src/deliverability');

const POOL = { sending: { smtp: { host: 'mail.acme.test' }, mailboxes: [{ email: 'old@acme.test', replyOnly: true }, { email: 'new@other.test' }] } };

describe('replyOnly mailboxes', () => {
  it('send no cold mail and do not count toward daily capacity', () => {
    const inst = lw({ over: POOL });
    assert.equal(d.poolCapacity(inst.cfg, '2026-10-20'), d.mailboxCap(inst.cfg, d.mailboxes(inst.cfg)[1], '2026-10-20'));
    const { added: [lead] } = inst.addLeads([LEAD]);
    const m = inst.queueEmail({ leadId: lead.id, ...GOOD, why: 'test' });
    inst.approve(m.id, { actor: 'human' });
    const [r] = inst.sendApproved();
    assert.equal(r.status, 'sent'); assert.equal(r.mailbox, 'new@other.test');
  });
  it('hold mail to someone first emailed from a replyOnly mailbox instead of switching mailboxes', () => {
    const inst = lw({ over: POOL });
    const { added: [lead] } = inst.addLeads([LEAD]);
    inst.store.append('sends.jsonl', { id: 'm0', to: lead.email, day: '2026-10-13', ts: '2026-10-13T15:00:00Z', status: 'sent', mailbox: 'old@acme.test' });
    const m = inst.queueEmail({ leadId: lead.id, ...GOOD, why: 'test' });
    inst.approve(m.id, { actor: 'human' });
    const [r] = inst.sendApproved();
    assert.notEqual(r.status, 'sent');
    assert.match(r.reasons.join(), /replyOnly/);
  });
  it('still answer people who wrote to them', () => {
    const inst = lw({ over: { ...POOL, sending: { ...POOL.sending, mode: 'send' } } });
    const { added: [lead] } = inst.addLeads([LEAD]);
    const m = inst.queueEmail({ leadId: lead.id, subject: 'Re: booking', body: 'Thanks Dana, happy to help.', why: 'answering', kind: 'reply' });
    inst._update(m.id, x => { x.replyFrom = 'old@acme.test'; });
    inst.approve(m.id, { actor: 'human' });
    const [r] = inst.sendApproved();
    assert.equal(r.status, 'sent'); assert.equal(r.mailbox, 'old@acme.test');
  });
});
