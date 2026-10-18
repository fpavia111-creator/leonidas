'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { checkEmail, renderFooter, SUBJECT_MAX_EXCLUSIVE, subjectLimit } = require('../src/compliance');
const { cfg } = require('./helpers');

const c = cfg();
const body = 'Saw your site has no online booking. Worth a chat?' + renderFooter(c);
const chk = (o, kind = 'cold', conf = c) => checkEmail({ to: 'a@b.test', body, ...o }, { cfg: conf, kind });

describe('subject length (< 30 chars, hard error)', () => {
  it('limit constant is 30 exclusive', () => assert.equal(SUBJECT_MAX_EXCLUSIVE, 30));
  it('29 chars passes', () => assert.ok(chk({ subject: 'a'.repeat(29).toLowerCase() }).ok));
  it('30 chars fails', () => {
    const r = chk({ subject: 'x'.repeat(30) });
    assert.equal(r.ok, false);
    assert.match(r.errors.join(), /under 30/);
  });
  it('applies to follow-ups too', () => assert.equal(chk({ subject: 'following up about the thing we said' }, 'followup').ok, false));
  it('config cannot loosen the limit', () => {
    const loose = cfg({ compliance: { maxSubjectLength: 90 } });
    assert.equal(subjectLimit(loose), 29);
    assert.equal(chk({ subject: 'y'.repeat(40) }, 'cold', loose).ok, false);
  });
  it('config can tighten it', () => {
    const tight = cfg({ compliance: { maxSubjectLength: 15 } });
    assert.equal(chk({ subject: 'sixteen chars xx' }, 'cold', tight).ok, false);
  });
});

describe('body length (< 100 words excl. footer, hard error)', () => {
  const { BODY_MAX_WORDS_EXCLUSIVE, bodyWordLimit } = require('../src/compliance');
  const words = n => Array.from({ length: n }, (_, i) => 'w' + i).join(' ');
  const b = (n, conf = c) => words(n) + renderFooter(conf);
  it('limit constant is 100 exclusive', () => assert.equal(BODY_MAX_WORDS_EXCLUSIVE, 100));
  it('99 words passes (footer not counted)', () => assert.deepEqual(chk({ subject: 'hi', body: b(99) }).errors, []));
  it('100 words fails', () => {
    const r = chk({ subject: 'hi', body: b(100) });
    assert.equal(r.ok, false); assert.match(r.errors.join(), /under 100 words/);
  });
  it('applies to follow-ups', () => assert.equal(chk({ subject: 'hi', body: b(100) }, 'followup').ok, false));
  it('config cannot loosen', () => {
    const loose = cfg({ compliance: { maxBodyWords: 220 } });
    assert.equal(bodyWordLimit(loose), 99);
    assert.equal(chk({ subject: 'hi', body: b(100, loose) }, 'cold', loose).ok, false);
  });
  it('config can tighten', () => {
    const tight = cfg({ compliance: { maxBodyWords: 50 } });
    assert.equal(chk({ subject: 'hi', body: b(51, tight) }, 'cold', tight).ok, false);
    assert.equal(chk({ subject: 'hi', body: b(50, tight) }, 'cold', tight).ok, true);
  });
  it('writer prompt states the limit', () => assert.match(require('../src/prompts').writerPrompt({ lead: {}, icp: { id: 'x' }, sender: {} }), /under 100 words/));
  it('every ICP template declares the limit', () => {
    const fs = require('fs'); const path = require('path'); const d = path.join(__dirname, '..', 'templates', 'icp');
    for (const f of fs.readdirSync(d)) assert.equal(JSON.parse(fs.readFileSync(path.join(d, f))).bodyMaxWordsExclusive, 100, f);
  });
});

describe('CAN-SPAM + content gate', () => {
  it('clean email passes', () => assert.deepEqual(chk({ subject: 'online booking' }).errors, []));
  it('footer has address + unsubscribe', () => {
    const f = renderFooter(c);
    assert.match(f, /100 Main St/); assert.match(f, /unsubscribe/i);
  });
  it('missing footer fails', () => {
    const r = checkEmail({ to: 'a@b.test', subject: 'hi there', body: 'plain body' }, { cfg: c });
    assert.ok(r.errors.some(e => /unsubscribe/.test(e)));
    assert.ok(r.errors.some(e => /postal address/.test(e)));
  });
  it('missing physical address config fails', () => {
    const r = chk({ subject: 'ok' }, 'cold', cfg({ sender: { physicalAddress: '' } }));
    assert.ok(r.errors.some(e => /physicalAddress/.test(e)));
  });
  it('fake Re: on first touch fails, ok on followup', () => {
    assert.equal(chk({ subject: 'Re: your site' }).ok, false);
    assert.equal(chk({ subject: 'Re: your site' }, 'followup').ok, true);
  });
  it('banned phrases', () => assert.ok(chk({ subject: 'act now' }).errors.some(e => /banned/.test(e))));
  it('merge tags', () => assert.ok(chk({ subject: 'hi {{first_name}}' }).errors.some(e => /merge/.test(e))));
  it('link budget ignores unsubscribe url', () => {
    const c2 = cfg({ compliance: { unsubscribe: { url: 'https://acme.test/u' } } });
    const b = 'See https://acme.test/demo' + renderFooter(c2);
    assert.equal(checkEmail({ to: 'a@b.test', subject: 'demo', body: b }, { cfg: c2 }).ok, true);
    assert.equal(checkEmail({ to: 'a@b.test', subject: 'demo', body: 'https://x.test https://y.test' + renderFooter(c2) }, { cfg: c2 }).ok, false);
  });
  it('html rejected', () => assert.equal(chk({ subject: 'hi', body: '<div>x</div>' + renderFooter(c) }).ok, false));
  it('role address rejected', () => assert.equal(checkEmail({ to: 'postmaster@b.test', subject: 'hi', body }, { cfg: c }).ok, false));
  it('header injection rejected', () => assert.equal(chk({ subject: 'hi\r\nBcc: x@y.test' }).ok, false));
  it('invalid recipient', () => assert.equal(checkEmail({ to: 'nope', subject: 'hi', body }, { cfg: c }).ok, false));
  it('warnings for ! in subject', () => assert.ok(chk({ subject: 'hello!' }).warnings.length));
});
