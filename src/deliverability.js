'use strict';
/** Per-day caps, warmup ramp, per-domain caps, bounce-rate circuit breaker, DNS auth checks. */
const dns = require('dns').promises;

function dayKey(d = new Date(), tz = 'UTC') {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

function daysBetween(a, b) {
  return Math.floor((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
}

/** Effective cap for today = min(dailyCap, warmup ramp). */
function effectiveDailyCap(cfg, today) {
  const s = cfg.sending;
  if (!s.warmup || !s.warmup.enabled) return s.dailyCap;
  const start = s.warmup.startDate || today;
  const n = Math.max(0, daysBetween(start, today));
  if (Array.isArray(s.ramp) && s.ramp.length) {
    // Explicit ramp: day 1 -> ramp[0], day 2 -> ramp[1], ... then dailyCap.
    return Math.min(s.dailyCap, n < s.ramp.length ? s.ramp[n] : s.dailyCap);
  }
  return Math.min(s.dailyCap, s.warmup.startPerDay + n * s.warmup.incrementPerDay);
}

/** Minutes since midnight of `d` in tz. */
function minutesIn(d, tz) {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d);
  const g = t => Number(p.find(x => x.type === t).value);
  return g('hour') * 60 + g('minute');
}
const toMin = hhmm => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + m; };

/** Is `d` inside [start, end) in tz? Handles windows that wrap past midnight. Empty -> null. */
function inWindow(d, tz, start, end) {
  if (!start || !end) return null;
  const now = minutesIn(d, tz), a = toMin(start), b = toMin(end);
  return a <= b ? (now >= a && now < b) : (now >= a || now < b);
}

function isQuietHours(cfg, d = new Date()) {
  const q = (cfg.usage && cfg.usage.quietHours) || {};
  return inWindow(d, q.timezone || cfg.sending.timezone || 'America/Chicago', q.start, q.end) === true;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function weekdayIn(d, tz) {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(d);
}

/** Hard rule: cold email only ever goes out Tue/Wed. Config may narrow this, never widen it. */
const HARD_DAYS = ['Tue', 'Wed'];
/** ...and it must be Tue/Wed in this timezone too (the sender's home zone), whatever the recipient's. */
const HARD_TZ = 'America/Chicago';

function allowedDays(cfg) {
  const a = (cfg.sending.allowedDays && cfg.sending.allowedDays.length) ? cfg.sending.allowedDays : HARD_DAYS;
  const norm = a.map(x => String(x).slice(0, 1).toUpperCase() + String(x).slice(1, 3).toLowerCase()).filter(x => HARD_DAYS.includes(x));
  return norm.length ? [...new Set(norm)] : HARD_DAYS;
}

/** Is `now` an allowed send day in timezone tz (and in America/Chicago)? */
function isAllowedDay(cfg, now, tz) {
  const days = allowedDays(cfg);
  return days.includes(weekdayIn(now, tz)) && days.includes(weekdayIn(now, HARD_TZ));
}

/** Calendar date (YYYY-MM-DD, in tz) of the next allowed send day on or after `now`. */
function nextAllowedDay(cfg, now = new Date(), tz = cfg.sending.timezone) {
  for (let i = 0; i < 8 * 24; i++) {
    const d = new Date(now.getTime() + i * 3600000);
    if (isAllowedDay(cfg, d, tz)) return dayKey(d, tz);
  }
  throw new Error('sending.allowedDays has no valid weekday');
}

function sendsOn(sendLog, day) { return sendLog.filter(r => r.day === day && r.status === 'sent'); }

function bounceStats(sendLog, bounces) {
  const sent = sendLog.filter(r => r.status === 'sent').length;
  const hard = bounces.filter(b => b.type === 'hard').length;
  return { sent, hardBounces: hard, rate: sent ? hard / sent : 0 };
}

/** Can one more message to `email` go out today? Returns {ok, reasons[], cap, used}. */
function canSend(cfg, { sendLog, bounces, email, now = new Date(), recipientTz }) {
  const reasons = [];
  const tz = recipientTz || cfg.sending.timezone || 'America/Chicago';
  let sendAfter = null;
  if (!isAllowedDay(cfg, now, tz)) {
    sendAfter = nextAllowedDay(cfg, now, tz);
    reasons.push(`not an allowed send day: cold email only goes out on ${allowedDays(cfg).join('/')} (${tz}); queued for ${sendAfter}`);
  }
  const day = dayKey(now, cfg.sending.timezone);
  const cap = effectiveDailyCap(cfg, day);
  const today = sendsOn(sendLog, day);
  if (today.length >= cap) reasons.push(`daily cap reached (${today.length}/${cap}${cfg.sending.warmup.enabled ? ', warmup' : ''})`);
  const domain = String(email).toLowerCase().split('@')[1];
  const perDomain = today.filter(r => (r.to || '').toLowerCase().endsWith('@' + domain)).length;
  if (perDomain >= cfg.sending.perDomainDailyCap) reasons.push(`per-domain cap reached for ${domain} (${perDomain}/${cfg.sending.perDomainDailyCap})`);
  const senderTz = cfg.sending.timezone || HARD_TZ;
  const w = cfg.sending.window || {};
  if (!sendAfter && inWindow(now, senderTz, w.start, w.end) === false) reasons.push(`outside send window ${w.start}-${w.end} (${senderTz})`);
  if (isQuietHours(cfg, now)) reasons.push(`quiet hours ${cfg.usage.quietHours.start}-${cfg.usage.quietHours.end}`);
  const gap = Number(cfg.sending.minIntervalSeconds) || 0;
  if (gap > 0) {
    const last = sendLog.filter(r => r.status === 'sent' && r.ts).map(r => Date.parse(r.ts)).sort((a, b) => b - a)[0];
    if (last && (now.getTime() - last) / 1000 < gap) reasons.push(`send interval: ${Math.ceil(gap - (now.getTime() - last) / 1000)}s until next send (min ${gap}s)`);
  }
  const b = bounceStats(sendLog, bounces);
  if (b.sent >= cfg.sending.minSendsForBounceRate && b.rate > cfg.sending.maxBounceRate) {
    reasons.push(`sending paused: hard-bounce rate ${(b.rate * 100).toFixed(1)}% > ${(cfg.sending.maxBounceRate * 100).toFixed(1)}%`);
  }
  return { ok: reasons.length === 0, reasons, cap, used: today.length, day, sendAfter, dayBlocked: !!sendAfter };
}

/** Classify a bounce from an SMTP status/diagnostic string. */
function classifyBounce(code = '', diagnostic = '') {
  const c = String(code).trim();
  const d = String(diagnostic).toLowerCase();
  if (/^5\.\d\.\d$|^5\d\d$/.test(c) || /user unknown|no such user|does not exist|mailbox unavailable|invalid recipient/.test(d)) return 'hard';
  if (/complain|spam report|abuse/.test(d)) return 'complaint';
  return 'soft';
}

/** SPF / DMARC lookup (DKIM needs a selector). Never throws. */
async function checkDomainAuth(domain, { resolver = dns, dkimSelector } = {}) {
  const out = { domain, spf: null, dmarc: null, dkim: null, problems: [] };
  const txt = async name => { try { return (await resolver.resolveTxt(name)).map(r => r.join('')); } catch { return []; } };
  const root = await txt(domain);
  out.spf = root.find(r => /^v=spf1/i.test(r)) || null;
  if (!out.spf) out.problems.push('no SPF record');
  else if (/\+all\b/.test(out.spf)) out.problems.push('SPF uses +all (anyone can send as you)');
  const dm = await txt(`_dmarc.${domain}`);
  out.dmarc = dm.find(r => /^v=DMARC1/i.test(r)) || null;
  if (!out.dmarc) out.problems.push('no DMARC record');
  if (dkimSelector) {
    const dk = await txt(`${dkimSelector}._domainkey.${domain}`);
    out.dkim = dk.find(r => /p=/.test(r)) || null;
    if (!out.dkim) out.problems.push(`no DKIM key at selector "${dkimSelector}"`);
  }
  return out;
}

module.exports = { HARD_DAYS, HARD_TZ, inWindow, isQuietHours, minutesIn, WEEKDAYS, weekdayIn, allowedDays, isAllowedDay, nextAllowedDay, dayKey, daysBetween, effectiveDailyCap, canSend, bounceStats, classifyBounce, checkDomainAuth };
