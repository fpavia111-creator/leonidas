'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { TOOLS, canonicalTool } = require('../src/mcp');
const { stateDir, envVar } = require('../src/config');
const lib = require('../src');
const license = require('../src/license');
const pkg = require('../package.json');
const { tmp } = require('./helpers');

describe('rename to Leonidas of the Web', () => {
  it('package name, bins and version', () => {
    assert.equal(pkg.name, '@kurtfrancisco/leonidas');
    assert.equal(pkg.bin.leonidas, 'bin/leonidas.js');
    assert.equal(pkg.bin.leadwright, 'bin/leadwright.js');
  });
  it('tools are leo_*; lw_* resolve as aliases', () => {
    assert.ok(TOOLS.every(t => t.name.startsWith('leo_')));
    assert.equal(canonicalTool('lw_send_approved'), 'leo_send_approved');
    assert.equal(canonicalTool('leo_why'), 'leo_why');
  });
  it('Leonidas class with Leadwright alias', () => { assert.equal(lib.Leonidas, lib.Leadwright); });
  it('env: LEONIDAS_* preferred, LEADWRIGHT_* fallback', () => {
    assert.equal(envVar('HOME', { LEADWRIGHT_HOME: '/old' }), '/old');
    assert.equal(envVar('HOME', { LEADWRIGHT_HOME: '/old', LEONIDAS_HOME: '/new' }), '/new');
  });
  it('state dir .leonidas, legacy .leadwright still used if it is the only one', () => {
    const save = { ...process.env }; delete process.env.LEONIDAS_HOME; delete process.env.LEADWRIGHT_HOME;
    try {
      const d = tmp();
      assert.equal(stateDir(d), path.join(d, '.leonidas'));
      fs.mkdirSync(path.join(d, '.leadwright'));
      assert.equal(stateDir(d), path.join(d, '.leadwright'));
      fs.mkdirSync(path.join(d, '.leonidas'));
      assert.equal(stateDir(d), path.join(d, '.leonidas'));
    } finally { Object.assign(process.env, save); }
  });
  it('license product id is unchanged so existing keys work', () => {
    assert.match(fs.readFileSync(path.join(__dirname, '..', 'src', 'license.js'), 'utf8'), /PRODUCT = 'leadwright-pro'/);
    assert.ok(license);
  });
  it('deprecated leadwright command still works and warns', () => {
    const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'leadwright.js'), '--help'], { encoding: 'utf8' });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Leonidas of the Web/);
    assert.match(r.stderr, /deprecated/);
  });
  it('Harvey credit kept', () => {
    assert.match(fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8'), /Harvey.*Ethan Rogers/);
    assert.match(fs.readFileSync(path.join(__dirname, '..', 'LICENSE'), 'utf8'), /Ethan Rogers/);
  });
});
