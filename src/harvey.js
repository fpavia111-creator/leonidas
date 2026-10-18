'use strict';
/**
 * Convert a Harvey-style config (persona / product / offer / icp / channels / usage / brain,
 * snake_case) into Leonidas's config schema. Business-agnostic: every value comes from input.
 * Returns { config, notes[] } where notes explain every normalization or ignored field.
 */

/** "10 minutes" | "1 hour" | "90" | 30 -> minutes (number) or null. */
function parseDurationMinutes(v) {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
  const m = String(v || '').trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours)?$/);
  if (!m) return null;
  const n = Number(m[1]);
  return /^h/.test(m[2] || '') ? n * 60 : n;
}

/** "1-20 employees" -> "1-20" (Leonidas's companySize format). */
function normalizeCompanySize(v) {
  const m = String(v || '').match(/(\d[\d,]*)\s*(?:-|to|–)\s*(\d[\d,]*)/);
  return m ? `${m[1].replace(/,/g, '')}-${m[2].replace(/,/g, '')}` : String(v || '');
}

const DAY = { sun: 'Sun', mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat' };

function fromHarvey(h = {}) {
  const notes = [];
  const persona = h.persona || {}, product = h.product || {}, offer = product.offer || h.offer || {};
  const icp = h.icp || {}, email = (h.channels || {}).email || {}, li = (h.channels || {}).linkedin || {};
  const usage = h.usage || {}, brain = h.brain || {};
  const cfg = {
    sender: { name: persona.name || '', company: persona.company || '', email: persona.email || '', physicalAddress: persona.postal_address || '', role: persona.role || '', tone: persona.tone || '', linkedin: persona.linkedin || '' },
    product: { name: product.name || '', description: product.description || '', pricing: product.pricing || '', keyBenefits: product.key_benefits || [], objectionResponses: product.objection_responses || {} },
    offer: { primary: offer.primary || '', entry: offer.entry || '', goal: offer.goal || 'get_reply', bookingMethod: offer.booking_method || 'reply', bookingUrl: offer.booking_url || '', meetingOwner: offer.meeting_owner || '' },
    icp: { industries: icp.industries || [], titles: icp.titles || [], companySize: normalizeCompanySize(icp.company_size), geography: icp.geography || [] },
    sending: { mode: 'draft' },
    approval: { required: email.require_approval !== false },
    usage: {},
    brain: { provider: brain.provider || '' },
    channels: { linkedin: { enabled: !!li.enabled, maxDailyConnections: li.max_daily_connections || 0, maxDailyMessages: li.max_daily_messages || 0 } },
  };
  if (offer.meeting_duration !== undefined) {
    const mins = parseDurationMinutes(offer.meeting_duration);
    if (mins == null) notes.push(`offer.meeting_duration "${offer.meeting_duration}" not understood; default kept`);
    else { cfg.offer.meetingDurationMinutes = mins; if (mins !== offer.meeting_duration) notes.push(`offer.meeting_duration "${offer.meeting_duration}" -> meetingDurationMinutes ${mins}`); }
  }
  if (icp.company_size && cfg.icp.companySize !== icp.company_size) notes.push(`icp.company_size "${icp.company_size}" -> "${cfg.icp.companySize}"`);
  const s = cfg.sending;
  if (email.enabled === false) notes.push('channels.email.enabled is false: kept in draft mode');
  if (email.provider) {
    s.provider = email.provider;
    if (String(email.provider).toLowerCase() === 'smtp') {
      s.transport = 'smtp';
      s.smtp = { host: email.smtp_host || '', port: email.smtp_port || 587, user: email.smtp_user || persona.email || '', passwordEnv: email.smtp_password_env || 'LEONIDAS_SMTP_PASSWORD' };
      notes.push('channels.email.provider smtp -> sending.transport "smtp"; set sending.smtp.host and the password env var');
    } else notes.push(`channels.email.provider "${email.provider}" recorded; use sending.transport file|command|smtp`);
  }
  if (email.max_daily_sends !== undefined) s.dailyCap = email.max_daily_sends;
  if (email.send_unverified !== undefined) s.sendUnverified = !!email.send_unverified;
  if (email.personalize_first_email !== undefined) s.personalizeFirstEmail = !!email.personalize_first_email;
  if (email.max_bounce_rate !== undefined) s.maxBounceRate = email.max_bounce_rate;
  if (email.send_interval_seconds !== undefined) s.minIntervalSeconds = email.send_interval_seconds;
  if (email.send_window_start || email.send_window_end) s.window = { start: email.send_window_start || '', end: email.send_window_end || '' };
  if (email.send_days) s.allowedDays = email.send_days.map(d => DAY[String(d).slice(0, 3).toLowerCase()] || d);
  if (email.send_ramp) { s.ramp = email.send_ramp; s.warmup = { enabled: true }; }
  if (email.timezone) s.timezone = email.timezone;
  if (usage.max_daily_claude_percent !== undefined) cfg.usage.maxDailyBrainPercent = usage.max_daily_claude_percent;
  if (usage.heartbeat_interval_minutes !== undefined) cfg.usage.heartbeatIntervalMinutes = usage.heartbeat_interval_minutes;
  if (usage.quiet_hours) cfg.usage.quietHours = { start: String(usage.quiet_hours.start || ''), end: String(usage.quiet_hours.end || ''), timezone: usage.quiet_hours.timezone || '' };
  if (li.enabled) notes.push('channels.linkedin is enabled but Leonidas has no LinkedIn sender; settings are stored only');
  return { config: cfg, notes };
}

module.exports = { fromHarvey, parseDurationMinutes, normalizeCompanySize };
