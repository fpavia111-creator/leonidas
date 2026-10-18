'use strict';
/** Industry ICP templates and deterministic lead scoring with human-readable reasons. */
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'templates', 'icp');

function listTemplates(dir = DIR) {
  return fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
}

function getTemplate(id, dir = DIR) {
  return listTemplates(dir).find(t => t.id === id) || null;
}

/** Merge a template with explicit icp overrides from config. */
function resolveIcp(icpCfg = {}, dir = DIR) {
  const base = icpCfg.template ? getTemplate(icpCfg.template, dir) : null;
  if (icpCfg.template && !base) throw new Error(`unknown ICP template "${icpCfg.template}"`);
  const pick = (k) => (icpCfg[k] && icpCfg[k].length ? icpCfg[k] : (base ? base[k] : undefined));
  return {
    id: base ? base.id : 'custom',
    industries: pick('industries') || [],
    titles: pick('titles') || [],
    companySize: icpCfg.companySize || (base && base.companySize) || '',
    geography: icpCfg.geography || [],
    signals: (base && base.signals) || [],
    disqualifiers: (base && base.disqualifiers) || [],
    minScore: icpCfg.minScore != null ? icpCfg.minScore : (base ? base.minScore : 50),
  };
}

function parseRange(r) {
  const m = String(r || '').match(/(\d+)\s*-\s*(\d+)/);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

const lc = s => String(s || '').toLowerCase();
const anyMatch = (val, list) => (lc(val) ? list.find(x => lc(val).includes(lc(x)) || lc(x).includes(lc(val))) : undefined);

/** Score 0-100. Returns {score, qualified, reasons[], disqualified}. */
function scoreLead(lead, icp) {
  const reasons = [];
  let score = 0;
  const ind = anyMatch(lead.industry, icp.industries);
  if (lead.industry && ind) { score += 30; reasons.push(`industry "${lead.industry}" matches ICP "${ind}"`); }
  else if (lead.industry) reasons.push(`industry "${lead.industry}" not in ICP`);
  const t = anyMatch(lead.title, icp.titles);
  if (lead.title && t) { score += 25; reasons.push(`title "${lead.title}" matches "${t}"`); }
  const range = parseRange(icp.companySize);
  if (range && Number.isFinite(Number(lead.employees))) {
    const n = Number(lead.employees);
    if (n >= range[0] && n <= range[1]) { score += 15; reasons.push(`${n} employees within ${icp.companySize}`); }
    else reasons.push(`${n} employees outside ${icp.companySize}`);
  }
  if (icp.geography.length && lead.location) {
    const g = anyMatch(lead.location, icp.geography);
    if (g) { score += 10; reasons.push(`location "${lead.location}" in ${g}`); }
  }
  const sigs = (lead.signals || []).filter(Boolean);
  if (sigs.length) { const add = Math.min(20, sigs.length * 10); score += add; reasons.push(`signals: ${sigs.join('; ')}`); }
  const dq = icp.disqualifiers.find(d => lc(lead.industry).includes(lc(d)) || lc(lead.notes).includes(lc(d)));
  if (dq) { reasons.push(`disqualified: "${dq}"`); score = 0; }
  if (!lead.email_verified && lead.email_status !== 'verified') reasons.push('email not verified');
  score = Math.min(100, score);
  return { score, qualified: !dq && score >= icp.minScore, reasons, disqualified: dq || null };
}

module.exports = { DIR, listTemplates, getTemplate, resolveIcp, scoreLead };
