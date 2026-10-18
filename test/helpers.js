'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Leadwright } = require('../src/engine');
const { DEFAULTS, deepMerge } = require('../src/config');

const TUE = new Date('2026-10-20T15:00:00Z'); // Tue 10:00 America/Chicago
const SAT = new Date('2026-10-17T15:00:00Z'); // Sat
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lw-'));

function cfg(over = {}) {
  return deepMerge(DEFAULTS, deepMerge({
    sender: { name: 'Kurt', company: 'Acme Ops', email: 'kurt@acme.test', physicalAddress: '100 Main St, Chicago, IL 60601' },
    compliance: { unsubscribe: { mailto: 'unsub@acme.test' } },
    sending: { mode: 'send', warmup: { enabled: false } },
    icp: { template: 'home_services' },
  }, over));
}

function lw({ now = TUE, over = {} } = {}) {
  let clock = now;
  const inst = new Leadwright({ dir: tmp(), cfg: cfg(over), now: () => clock });
  inst.setNow = d => { clock = d; };
  return inst;
}

const LEAD = { email: 'owner@cascadehvac.test', name: 'Dana', title: 'Owner', company: 'Cascade HVAC', industry: 'HVAC', employees: 12, signals: ['no online booking'], emailVerified: true };
const GOOD = { subject: 'booking on your site', body: 'Dana, noticed Cascade HVAC has no way to book online. Worth a look?' };

module.exports = { TUE, SAT, tmp, cfg, lw, LEAD, GOOD };
