'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { lw, LEAD, GOOD, TUE } = require('./helpers');

const SEQ = { sequence: { followups: [
  { afterDays: 7, body: 'Hi {first}, following up on my note about booking online. Worth a look?' },
  { afterDays: 7, body: 'Hi {first}, last note from me on this. Reply "stop" and I will not write again.' },
] } };
const DAY = 86400000;

function sentLead(inst) {
  const { added: [lead] } = inst.addLeads([{ ...LEAD, name: 'Dana Ruiz' }]);
  const msg = inst.queueEmail({ leadId: lead.id, ...GOOD, why: 'HVAC owner, no online booking' });
  if (msg.status === 'pending_approval') inst.approve(msg.id, { actor: 'human' });
  assert.equal(inst.sendApproved()[0].status, 'sent');
  return { lead, msg: inst.outbox().find(m => m.id === msg.id) };
}

describe('follow-up sequence', () => {
  it('queues nothing without sequence.followups, or before afterDays have passed', () => {
    const plain = lw(); sentLead(plain);
    assert.deepEqual(plain.queueFollowups(), { queued: [], skipped: 0 });
    const inst = lw({ over: SEQ }); sentLead(inst);
    inst.setNow(new Date(TUE.getTime() + 6 * DAY));
    assert.deepEqual(inst.queueFollowups().queued, []);
  });

  it('after afterDays: threaded "Re:" follow-up from the same mailbox, first name filled in', () => {
    const inst = lw({ over: SEQ });
    const { msg } = sentLead(inst);
    inst.setNow(new Date(TUE.getTime() + 7 * DAY));
    const r = inst.queueFollowups();
    assert.equal(r.queued.length, 1);
    const f = inst.outbox().find(m => m.id === r.queued[0]);
    assert.equal(f.kind, 'followup');
    assert.equal(f.subject, `Re: ${GOOD.subject}`);
    assert.match(f.body, /^Hi Dana, following up/);
    assert.equal(f.inReplyTo, `<${msg.id}@acme.test>`);
    assert.equal(f.replyFrom, msg.from);
    assert.equal(f.step, 1);
    assert.equal(inst.queueFollowups().queued.length, 0, 'step 1 is not queued twice');
  });

  it('step 2 waits for step 1 to be sent plus afterDays, and references the whole thread', () => {
    const inst = lw({ over: SEQ });
    const { msg } = sentLead(inst);
    inst.setNow(new Date(TUE.getTime() + 7 * DAY));
    const [f1] = inst.queueFollowups().queued;
    inst.approve(f1, { actor: 'human' });
    assert.equal(inst.sendApproved()[0].status, 'sent');
    assert.equal(inst.queueFollowups().queued.length, 0);
    inst.setNow(new Date(TUE.getTime() + 14 * DAY));
    const [f2] = inst.queueFollowups().queued;
    const m2 = inst.outbox().find(m => m.id === f2);
    assert.equal(m2.step, 2);
    assert.equal(m2.inReplyTo, `<${f1}@acme.test>`);
    assert.equal(m2.references, `<${msg.id}@acme.test> <${f1}@acme.test>`);
    const eml = fs.readFileSync(path.join(inst.dir, 'sent', `${f1}.eml`), 'utf8');
    assert.match(eml, new RegExp(`In-Reply-To: <${msg.id}@acme\\.test>`));
    inst.setNow(new Date(TUE.getTime() + 30 * DAY));
    inst.approve(f2, { actor: 'human' }); inst.sendApproved();
    assert.equal(inst.queueFollowups().queued.length, 0, 'the sequence ends after the last step');
  });

  it('no follow-up for a lead who replied, bounced or opted out', () => {
    for (const stop of ['reply', 'bounce', 'suppress']) {
      const inst = lw({ over: SEQ });
      const { lead } = sentLead(inst);
      if (stop === 'reply') { const ls = inst.leads(); ls.find(l => l.id === lead.id).repliedAt = new Date().toISOString(); inst._saveLeads(ls); }
      if (stop === 'bounce') inst.recordBounce({ email: lead.email, code: '550', diagnostic: 'user unknown' });
      if (stop === 'suppress') inst.suppress(lead.email, { reason: 'stop' });
      inst.setNow(new Date(TUE.getTime() + 8 * DAY));
      assert.equal(inst.queueFollowups().queued.length, 0, stop);
    }
  });

  it('with approval.required=false the follow-up is approved and sends', () => {
    const inst = lw({ over: { ...SEQ, approval: { required: false } } });
    sentLead(inst);
    inst.setNow(new Date(TUE.getTime() + 7 * DAY));
    const [id] = inst.queueFollowups().queued;
    assert.equal(inst.outbox().find(m => m.id === id).status, 'approved');
    assert.equal(inst.sendApproved()[0].status, 'sent');
  });
});
