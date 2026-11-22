'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { junkReason, mailDomainStatus } = require('../src/verify');
const { lw } = require('./helpers');

describe('junk addresses', () => {
  it('rejects scraped file names, placeholders and malformed addresses', () => {
    for (const e of ['vapes@72x-copy.avif', 'logo@2x.png', 'john.doe@apexlogistics.com', 'johndoe@gmail.com', 'nombre@correo.com',
      'example@gmail.com', 'hi@mystore.com', 'contact@sa-landscapes.comconnect', '-smoothlinesteam@gmail.com', 'ugb@xq.gab1', 'abc@sentry.io', 'plainword'])
      assert.ok(junkReason(e), `${e} should be junk`);
  });
  it('accepts real-looking business and personal addresses', () => {
    for (const e of ['info@bmbookkeeping.com', 'olgajimenez.realestate@outlook.com', 'k-carter35@yahoo.com', 'jesse@rivercity-strength.com', 'owner@cascade-hvac.co.uk'])
      assert.equal(junkReason(e), null, e);
  });
});

describe('mail domain status', () => {
  const err = code => Object.assign(new Error(code), { code });
  const resolver = recs => ({
    resolveMx: async d => { if (recs[d] && recs[d].mx) return recs[d].mx; throw err(recs[d] && recs[d].fail || 'ENOTFOUND'); },
    resolve4: async d => { if (recs[d] && recs[d].a) return recs[d].a; throw err('ENODATA'); },
    resolve6: async () => { throw err('ENODATA'); },
  });
  it('ok with an MX, ok with only an A record, no_mail_server with neither or a null MX', async () => {
    const r = resolver({ 'mx.test': { mx: [{ exchange: 'mail.mx.test', priority: 10 }] }, 'a.test': { fail: 'ENODATA', a: ['1.2.3.4'] }, 'null.test': { mx: [{ exchange: '.', priority: 0 }] } });
    assert.equal(await mailDomainStatus('mx.test', { resolver: r }), 'ok');
    assert.equal(await mailDomainStatus('a.test', { resolver: r }), 'ok');
    assert.equal(await mailDomainStatus('gone.test', { resolver: r }), 'no_mail_server');
    assert.equal(await mailDomainStatus('null.test', { resolver: r }), 'no_mail_server');
  });
  it('unknown on a DNS failure rather than guessing', async () => {
    assert.equal(await mailDomainStatus('x.test', { resolver: resolver({ 'x.test': { fail: 'ETIMEOUT' } }) }), 'unknown');
  });
});

describe('leads', () => {
  it('addLeads skips junk addresses with the reason', () => {
    const inst = lw();
    const r = inst.addLeads([{ email: 'vapes@72x-copy.avif' }, { email: 'owner@cascadehvac.test', name: 'Dana' }]);
    assert.equal(r.added.length, 1);
    assert.match(r.skipped[0].why, /invalid address: .*file name/);
  });
  it('verifyLeadDomains suppresses leads whose domain has no mail server and pulls their mail', async () => {
    const inst = lw();
    inst.addLeads([{ email: 'owner@cascadehvac.test', emailVerified: true }, { email: 'info@deadshop.test', emailVerified: true }]);
    const dead = inst.getLead('info@deadshop.test');
    const msg = inst.queueEmail({ leadId: dead.id, subject: 'booking on your site', body: 'Quick one. Worth a look?', why: 'test' });
    const resolver = {
      resolveMx: async d => { if (d === 'cascadehvac.test') return [{ exchange: 'mx.cascadehvac.test', priority: 1 }]; throw Object.assign(new Error('x'), { code: 'ENOTFOUND' }); },
      resolve4: async () => { throw Object.assign(new Error('x'), { code: 'ENOTFOUND' }); },
      resolve6: async () => { throw Object.assign(new Error('x'), { code: 'ENOTFOUND' }); },
    };
    const r = await inst.verifyLeadDomains({ resolver });
    assert.deepEqual(r, { checked: 2, ok: 1, noMailServer: ['info@deadshop.test'], unknown: [] });
    assert.ok(inst.suppression.match('info@deadshop.test'));
    assert.equal(inst.outbox().find(m => m.id === msg.id).status, 'blocked');
    assert.equal(inst.getLead('owner@cascadehvac.test').mailDomain, 'ok');
    assert.equal((await inst.verifyLeadDomains({ resolver })).checked, 0, 'checked leads are skipped');
  });
});
