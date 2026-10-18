'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { PassThrough } = require('stream');
const { execFileSync } = require('child_process');
const { listTemplates, resolveIcp, scoreLead } = require('../src/icp');
const { handle, serve, TOOLS } = require('../src/mcp');
const { writerPrompt } = require('../src/prompts');
const { toCsv, parseCsv } = require('../src/export');
const license = require('../src/license');
const crypto = require('crypto');
const { lw, LEAD, GOOD, tmp } = require('./helpers');

describe('ICP templates', () => {
  const ts = listTemplates();
  it('ships 8 industry templates', () => assert.equal(ts.length, 8));
  it('every example subject is under 30 chars', () => {
    for (const t of ts) for (const s of t.exampleSubjects) assert.ok(s.length < 30, `${t.id}: ${s}`);
  });
  it('scores a matching lead with reasons', () => {
    const icp = resolveIcp({ template: 'home_services' });
    const r = scoreLead({ ...LEAD }, icp);
    assert.ok(r.qualified); assert.ok(r.score >= 70);
    assert.ok(r.reasons.some(x => /industry/.test(x)));
  });
  it('disqualifiers zero the score', () => {
    const r = scoreLead({ ...LEAD, notes: 'franchise HQ office' }, resolveIcp({ template: 'home_services' }));
    assert.equal(r.score, 0); assert.equal(r.qualified, false);
  });
  it('unknown template throws', () => assert.throws(() => resolveIcp({ template: 'nope' })));
  it('config overrides template lists', () => assert.deepEqual(resolveIcp({ template: 'saas', titles: ['CTO'] }).titles, ['CTO']));
});

describe('writer prompt', () => {
  it('states the 30-char subject rule and footer handling', () => {
    const p = writerPrompt({ lead: LEAD, icp: { id: 'x' }, sender: { name: 'Kurt' } });
    assert.match(p, /under 30 characters/); assert.match(p, /footer/);
  });
});

describe('skills playbooks', () => {
  it('email frameworks document the 30-char limit', () => {
    assert.match(fs.readFileSync(path.join(__dirname, '..', 'skills', 'email_frameworks.md'), 'utf8'), /under 30 characters/);
  });
  it('keep Harvey attribution', () => {
    for (const f of fs.readdirSync(path.join(__dirname, '..', 'skills'))) {
      assert.match(fs.readFileSync(path.join(__dirname, '..', 'skills', f), 'utf8'), /Ethan Rogers/);
    }
  });
});

describe('CSV', () => {
  it('round-trips and neutralizes formulas', () => {
    const csv = toCsv([{ id: '1', email: 'a@b.test', company: 'Acme, Inc', name: '=HYPERLINK("x")' }]);
    assert.match(csv, /"'=HYPERLINK/);
    const [r] = parseCsv(csv);
    assert.equal(r.company, 'Acme, Inc');
  });
});

describe('MCP server', () => {
  const inst = lw();
  const call = (name, args) => handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, () => inst);
  it('initialize + tools/list', async () => {
    const i = await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, () => inst);
    assert.equal(i.result.serverInfo.name, 'leonidas');
    const l = await handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, () => inst);
    assert.equal(l.result.tools.length, TOOLS.length);
  });
  it('agent flow: add, queue, cannot approve', async () => {
    const add = JSON.parse((await call('leo_add_leads', { leads: [LEAD] })).result.content[0].text);
    const id = add.added[0].id;
    const q = JSON.parse((await call('lw_queue_email', { leadId: id, ...GOOD, why: 'fit' })).result.content[0].text);
    assert.equal(q.status, 'pending_approval');
    const ap = await call('lw_approve', { id: q.id });
    assert.equal(ap.result.isError, true); assert.match(ap.result.content[0].text, /human/);
    const w = JSON.parse((await call('lw_why', { lead: LEAD.email })).result.content[0].text);
    assert.equal(w.trail.length, 2);
  });
  it('check_email rejects 30+ char subject', async () => {
    const r = JSON.parse((await call('lw_check_email', { to: 'a@b.test', subject: 'this subject line is way too long', body: 'hi' })).result.content[0].text);
    assert.equal(r.ok, false);
  });
  it('unknown method / notification', async () => {
    assert.equal((await handle({ jsonrpc: '2.0', id: 3, method: 'x' }, () => inst)).error.code, -32601);
    assert.equal(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' }, () => inst), null);
  });
  it('stdio transport', async () => {
    const input = new PassThrough(), output = new PassThrough();
    serve({ input, output, makeLw: () => inst });
    const got = new Promise(r => output.once('data', d => r(JSON.parse(d.toString()))));
    input.write(JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'ping' }) + '\n');
    assert.equal((await got).id, 9);
  });
});

describe('CLI', () => {
  const bin = path.join(__dirname, '..', 'bin', 'leonidas.js');
  it('init creates draft-mode config with Tue/Wed', () => {
    const home = tmp();
    const out = execFileSync(process.execPath, [bin, 'init', '--icp', 'saas'], { env: { ...process.env, LEADWRIGHT_HOME: home } }).toString();
    assert.match(out, /Tue\/Wed/);
    const c = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
    assert.equal(c.sending.mode, 'draft'); assert.equal(c.icp.template, 'saas');
    const st = JSON.parse(execFileSync(process.execPath, [bin, 'status'], { env: { ...process.env, LEADWRIGHT_HOME: home } }).toString());
    assert.deepEqual(st.allowedDays, ['Tue', 'Wed']);
  });
  it('install-snippets covers all three hosts', () => {
    const out = execFileSync(process.execPath, [bin, 'install-snippets']).toString();
    assert.match(out, /claude mcp add/); assert.match(out, /mcp\.json/); assert.match(out, /config\.toml/);
  });
});

describe('license (SKS2, leadwright-pro)', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const pubHex = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
  const mk = p => { const m = Buffer.from(JSON.stringify(p)); return 'SKS2-' + m.toString('base64url') + '.' + crypto.sign(null, m, privateKey).toString('base64url'); };
  it('product id + shared public key', () => {
    assert.equal(license.PRODUCT, 'leadwright-pro');
    assert.equal(license.PUBLIC_KEY_HEX, '3dbbb56b1323d05f19a12b5a62cef225cd915388e68922c06698b0f1f327af8e');
  });
  it('accepts a valid key, rejects other products and forgeries', () => {
    assert.ok(license.validate(mk({ d: '2026-10-17', eh: 'x', oid: 'o1', p: 'leadwright-pro', v: 2 }), pubHex));
    assert.equal(license.validate(mk({ p: 'agent-guard-pro', v: 2 }), pubHex), false);
    assert.equal(license.validate(mk({ p: 'leadwright-pro', v: 2 })), false); // wrong key
    assert.equal(license.validate('SKS2-e30.e30'), false);
  });
});
