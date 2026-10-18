'use strict';
/**
 * Leonidas of the Web configuration. Safe by default:
 *  - sending.mode = "draft": nothing ever leaves the machine.
 *  - approval.required = true and approval.allowAgentApproval = false: only a human
 *    (CLI `leonidas approve`) can approve a message; the MCP agent cannot.
 */
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  sender: { name: '', company: '', email: '', physicalAddress: '' },
  compliance: {
    unsubscribe: { url: '', mailto: '' },
    footerTemplate: '\n\n--\n{company} · {physicalAddress}\nNot interested? Reply "unsubscribe" or opt out: {unsubscribe}',
    maxLinks: 1,
    maxBodyWords: 99,              // bodies must be UNDER 100 words excl. footer (hard error; may only tighten)
    maxSubjectLength: 29,          // subjects must be UNDER 30 chars (hard error)
    allowHtml: false,
    blockRoleAddresses: true,
  },
  sending: {
    mode: 'draft',            // draft | send   ("send" must be set explicitly)
    transport: 'file',        // file | command | smtp
    smtp: { host: '', port: 587, secure: null, user: '', passwordEnv: 'LEONIDAS_SMTP_PASSWORD', heloName: '', timeoutMs: 30000, caFile: '', rejectUnauthorized: true, allowPlaintext: false },
    command: '',              // e.g. "msmtp -t" when transport=command
    dailyCap: 30,
    perDomainDailyCap: 3,
    warmup: { enabled: true, startDate: '', startPerDay: 5, incrementPerDay: 3 },
    maxBounceRate: 0.05,
    minSendsForBounceRate: 20,
    timezone: 'America/Chicago', // used when a lead has no timezone of its own
    allowedDays: ['Tue', 'Wed'],  // cold email goes out ONLY on these weekdays (recipient tz)
  },
  approval: { required: true, allowAgentApproval: false },
  icp: { template: '', industries: [], titles: [], companySize: '', geography: [], minScore: 50 },
  // Optional sales context used by the writer prompt and objection handling.
  product: { name: '', description: '', pricing: '', keyBenefits: [], objectionResponses: {} },
  offer: { primary: '', entry: '', goal: 'get_reply', bookingMethod: 'reply', bookingUrl: '', meetingDurationMinutes: 15, meetingOwner: '' },
  usage: { maxDailyBrainPercent: 100, heartbeatIntervalMinutes: 15, quietHours: { start: '', end: '', timezone: '' } },
  brain: { provider: '' },
  channels: { linkedin: { enabled: false, maxDailyConnections: 0, maxDailyMessages: 0 } },
};
// sending.* also accepts: ramp [n1,n2,...] (per-day warmup caps), window {start,end} 'HH:MM',
// minIntervalSeconds, sendUnverified (default false), personalizeFirstEmail (default true).
Object.assign(DEFAULTS.sending, { ramp: [], window: { start: '', end: '' }, minIntervalSeconds: 0, sendUnverified: false, personalizeFirstEmail: true, provider: '' });

const BOOKING_METHODS = ['reply', 'link', 'ask_preference'];

function deepMerge(base, over) {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return over === undefined ? base : over;
  const out = { ...base };
  for (const k of Object.keys(over || {})) {
    out[k] = (k in base) ? deepMerge(base[k], over[k]) : over[k];
  }
  return out;
}

/** Read LEONIDAS_<name>, falling back to the deprecated LEADWRIGHT_<name>. */
function envVar(name, env = process.env) {
  return env['LEONIDAS_' + name] !== undefined ? env['LEONIDAS_' + name] : env['LEADWRIGHT_' + name];
}

/** State dir: $LEONIDAS_HOME, else ./.leonidas (an existing ./.leadwright from 0.1.x keeps working). */
function stateDir(cwd = process.cwd()) {
  const h = envVar('HOME');
  if (h) return h;
  const legacy = path.join(cwd, '.leadwright');
  const dir = path.join(cwd, '.leonidas');
  return !fs.existsSync(dir) && fs.existsSync(legacy) ? legacy : dir;
}

function configPath(dir = stateDir()) { return path.join(dir, 'config.json'); }

/** Read a config file (.json, .yaml or .yml). Returns {user, warnings}. */
function readConfigFile(p) {
  const text = fs.readFileSync(p, 'utf8');
  if (/\.ya?ml$/i.test(p)) {
    const r = require('./yaml').parse(text);
    return { user: r.value || {}, warnings: r.warnings.map(w => w.message) };
  }
  return { user: JSON.parse(text), warnings: [] };
}

/** Config file: $LEONIDAS_CONFIG (or legacy $LEADWRIGHT_CONFIG), else <dir>/config.yaml|config.yml|config.json. */
function findConfigFile(dir) {
  if (envVar('CONFIG')) return envVar('CONFIG');
  for (const f of ['config.yaml', 'config.yml', 'config.json']) { const p = path.join(dir, f); if (fs.existsSync(p)) return p; }
  return null;
}

function loadConfig(dir = stateDir(), file = findConfigFile(dir)) {
  if (!file) return deepMerge(DEFAULTS, {});
  return deepMerge(DEFAULTS, readConfigFile(file).user);
}

const isNum = v => typeof v === 'number' && Number.isFinite(v);
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Schema/type validation. Returns {errors[], warnings[]}. Never mutates cfg. */
function validateConfig(cfg) {
  const e = [], w = [];
  const s = cfg.sending || {};
  if (!['draft', 'send'].includes(s.mode)) e.push(`sending.mode must be "draft" or "send"`);
  if (!['file', 'command', 'smtp'].includes(s.transport)) e.push(`sending.transport must be "file", "command" or "smtp"`);
  const sm = s.smtp || {};
  if ('password' in sm || 'pass' in sm) e.push('sending.smtp.password must not be stored in config; use the env var named by sending.smtp.passwordEnv');
  if (s.transport === 'smtp') {
    if (!sm.host) (s.mode === 'send' ? e : w).push('sending.smtp.host is not set');
    if (![465, 587].includes(Number(sm.port))) w.push(`sending.smtp.port ${sm.port} is unusual; cPanel uses 465 (SSL) or 587 (STARTTLS)`);
    if (sm.allowPlaintext) w.push('sending.smtp.allowPlaintext is true: credentials may cross the network unencrypted (testing only)');
    if (sm.rejectUnauthorized === false) w.push('sending.smtp.rejectUnauthorized is false: TLS certificate is not verified');
  }
  if (!isNum(s.dailyCap) || s.dailyCap < 0) e.push('sending.dailyCap must be a non-negative number');
  if (!Array.isArray(s.ramp) || s.ramp.some(n => !isNum(n) || n < 0)) e.push('sending.ramp must be a list of non-negative numbers');
  else if (s.ramp.some(n => n > s.dailyCap)) w.push('sending.ramp has steps above sending.dailyCap; they are capped at dailyCap');
  if (!isNum(s.maxBounceRate) || s.maxBounceRate < 0 || s.maxBounceRate > 1) e.push('sending.maxBounceRate must be a fraction between 0 and 1');
  for (const k of ['start', 'end']) if (s.window && s.window[k] && !HHMM.test(s.window[k])) e.push(`sending.window.${k} must be HH:MM`);
  if (!isNum(s.minIntervalSeconds) || s.minIntervalSeconds < 0) e.push('sending.minIntervalSeconds must be >= 0');
  const days = (s.allowedDays || []).map(d => String(d).slice(0, 3).toLowerCase());
  const extra = days.filter(d => !['tue', 'wed'].includes(d));
  if (extra.length) w.push(`sending.allowedDays includes ${extra.join(', ')}: cold email is only ever sent Tue/Wed, those days are ignored`);
  if (s.sendUnverified) w.push('sending.sendUnverified is true: mail to unverified addresses raises bounce/blacklist risk');
  if (!cfg.approval.required) w.push('approval.required is false: messages can be sent without human review');
  const o = cfg.offer || {};
  if (!BOOKING_METHODS.includes(o.bookingMethod)) e.push(`offer.bookingMethod must be one of ${BOOKING_METHODS.join(', ')}`);
  if (o.bookingMethod === 'link' && !o.bookingUrl) e.push('offer.bookingMethod is "link" but offer.bookingUrl is empty');
  if (!isNum(o.meetingDurationMinutes) || o.meetingDurationMinutes <= 0) e.push('offer.meetingDurationMinutes must be a positive number of minutes');
  const p = cfg.product || {};
  if (!Array.isArray(p.keyBenefits) || p.keyBenefits.some(b => typeof b !== 'string')) e.push('product.keyBenefits must be a list of strings');
  if (!p.objectionResponses || typeof p.objectionResponses !== 'object' || Array.isArray(p.objectionResponses) || Object.values(p.objectionResponses).some(v => typeof v !== 'string')) e.push('product.objectionResponses must be a map of objection -> response');
  const u = cfg.usage || {};
  if (!isNum(u.maxDailyBrainPercent) || u.maxDailyBrainPercent < 0 || u.maxDailyBrainPercent > 100) e.push('usage.maxDailyBrainPercent must be 0-100');
  const q = u.quietHours || {};
  for (const k of ['start', 'end']) if (q[k] && !HHMM.test(q[k])) e.push(`usage.quietHours.${k} must be HH:MM`);
  if (!!q.start !== !!q.end) e.push('usage.quietHours needs both start and end');
  if (cfg.sender.physicalAddress === '' ) w.push('sender.physicalAddress is empty (required before sending)');
  return { errors: e, warnings: w };
}

function saveConfig(cfg, dir = stateDir()) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(configPath(dir), JSON.stringify(cfg, null, 2) + '\n');
}

/** Problems that block *sending* (drafting is always allowed). */
function sendReadiness(cfg) {
  const p = [];
  if (cfg.sending.mode !== 'send') p.push('sending.mode is "draft" (set it to "send" explicitly to allow delivery)');
  if (!cfg.sender.email) p.push('sender.email is not set');
  if (!cfg.sender.physicalAddress) p.push('sender.physicalAddress is not set (CAN-SPAM requires a valid postal address)');
  if (!cfg.compliance.unsubscribe.url && !cfg.compliance.unsubscribe.mailto) p.push('no unsubscribe url or mailto configured');
  if (cfg.sending.transport === 'command' && !cfg.sending.command) p.push('sending.transport is "command" but sending.command is empty');
  if (cfg.sending.transport === 'smtp') p.push(...require('./smtp').smtpProblems(cfg));
  return p;
}

module.exports = { envVar, DEFAULTS, BOOKING_METHODS, deepMerge, stateDir, configPath, readConfigFile, findConfigFile, validateConfig, loadConfig, saveConfig, sendReadiness };
