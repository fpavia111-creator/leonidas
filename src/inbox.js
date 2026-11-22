'use strict';
/**
 * Sorts incoming mail before any reply is considered. The rules come from Harvey's reply handler
 * (opt-out and escalation phrases): deterministic code decides what must NEVER get an automatic
 * answer; the agent only writes the words.
 *
 * Categories:
 *   opt_out     asked to stop. Suppressed at once, never answered.
 *   escalate    angry / legal / spam-report language. A human answers, never the agent.
 *   bounce      delivery failure. Recorded as a bounce (hard bounces suppress the address).
 *   auto_reply  out-of-office or other machine reply. Ignored.
 *   suspicious  looks like phishing or a scam. Never answered.
 *   automated   newsletters, receipts, notifications, no-reply senders. Ignored.
 *   own         sent by one of our own mailboxes. Ignored.
 *   needs_reply a person wrote and may get an answer.
 */

// From Harvey (handler.py): hard opt-out phrases, honored whatever a model thinks.
const OPT_OUT_PATTERNS = ['unsubscribe', 'opt out', 'opt-out', 'remove me', 'take me off', 'stop emailing', 'stop contacting', 'stop sending',
  'do not contact', 'do not email', "don't contact", "don't email", 'never contact', 'delete my info', 'delete my data',
  'dar de baja', 'darme de baja', 'no me escriban', 'no me contacten'];
const NO_THANKS_RE = /(?<!\bor )\bno,?[ \t]+thank(?:s|[ \t]+you)\b(?![ \t]+(?:needed|necessary|required))/i;
const BARE_OPT_OUTS = new Set(['stop', 'unsubscribe', 'remove', 'remove me', 'opt out', 'no thanks', 'no thank you', 'not interested', 'baja', 'no gracias', 'de baja']);
const MOBILE_SIG_RE = /^[ \t]*(?:sent from my \w[^\n]*|get outlook for \w[^\n]*|sent from \w+ mail[^\n]*|enviado desde mi \w[^\n]*)$/gim;

// From Harvey: phrases that mean a human must take over.
const ESCALATION_PATTERNS = ['lawyer', 'attorney', 'legal action', 'lawsuit', 'sue you', 'cease and desist', 'harassment', 'harassing', 'report you', 'reporting you',
  'spam complaint', 'reported as spam', 'report this as spam', 'ftc', 'gdpr', 'can-spam', 'blacklist', 'abogado'];

// Phishing and scam tells. A match means nobody answers automatically.
const SUSPICIOUS_RE = [
  /verify your (account|identity|email|password)/i, /(confirm|update|reset) your (password|login|billing|payment)/i,
  /review the attached (document|invoice|file|order)/i, /(invoice|payment|order|document) (is )?attached/i,
  /wire transfer|bank transfer details|gift ?cards?|bitcoin|crypto(currency)? wallet|western union/i,
  /your (account|mailbox) (will be|has been) (suspended|closed|deactivated|locked)/i,
  /(click|tap) (here|the link|below) to (view|download|access|unlock|verify|sign)/i,
  /docusign|shared a (document|file) with you|sent you a (secure|encrypted) (message|document)/i,
  /\b(seo|backlinks?|guest post|rank(ing)? (your|on) (website|google)|first page of google)\b/i,
  /urgent(ly)? (payment|response|reply) (needed|required)|kindly (send|provide|reply)/i,
];

const AUTO_SUBJECT_RE = /^(auto(matic)?[ -]?reply|out of (the )?office|ooo\b|away from|on vacation|respuesta autom|fuera de la oficina|abwesenheit)/i;
const BOUNCE_SUBJECT_RE = /undeliver(able|ed)|delivery (status notification|failure|has failed)|mail delivery (failed|subsystem)|returned mail|failure notice|could not be delivered|message not delivered/i;
const NOREPLY_RE = /^(no-?reply|do-?not-?reply|notifications?|notify|mailer-daemon|postmaster|bounces?|alerts?|news(letter)?|marketing|billing|receipts?|bookings?|calendar|cpanel|wordpress|automated|system)[+@._-]/i;

const flat = s => String(s || '').toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, ' ');

/** Which opt-out rule the reply trips (on their own words), or null. */
function optOutReason(own) {
  const f = flat(own);
  for (const p of OPT_OUT_PATTERNS) if (f.includes(p)) return `their reply contains "${p}"`;
  for (const line of String(own || '').split('\n')) { const m = line.match(NO_THANKS_RE); if (m) return `their reply says "${m[0].trim()}"`; }
  const bare = flat(String(own || '').replace(MOBILE_SIG_RE, '')).replace(/[^\w\s-]/g, '').trim();
  if (BARE_OPT_OUTS.has(bare)) return `their reply was only "${bare}"`;
  return null;
}

function escalationReason(own, subject) {
  const f = flat(subject + ' ' + own);
  const p = ESCALATION_PATTERNS.find(x => new RegExp(`(^|[^a-z])${x.replace(/[-]/g, '\\-')}([^a-z]|$)`).test(f));
  return p ? `mentions "${p}"` : null;
}

/** Bounce details from a delivery-status report: {recipient, code, diagnostic} or null. */
function bounceInfo(msg, ownAddresses) {
  const fromAddr = msg.from.email;
  const h = msg.headers;
  const isReport = /multipart\/report/i.test((h['content-type'] || [''])[0]);
  if (!isReport && !/^(mailer-daemon|postmaster)@/i.test(fromAddr) && !BOUNCE_SUBJECT_RE.test(msg.subject)) return null;
  const text = msg.dsn + '\n' + msg.body;
  const rec = (text.match(/Final-Recipient:\s*rfc822;\s*<?([^\s>;]+@[^\s>;]+)/i) || text.match(/Original-Recipient:\s*rfc822;\s*<?([^\s>;]+@[^\s>;]+)/i) || [])[1]
    || (text.match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g) || []).find(e => !ownAddresses.has(e.toLowerCase()) && !/mailer-daemon|postmaster/i.test(e));
  const code = (text.match(/Status:\s*([245]\.\d{1,3}\.\d{1,3})/i) || text.match(/\b([45]\d\d)[ -][45]\.\d/) || text.match(/\b(5\d\d)\b/) || [])[1] || '';
  const diagnostic = ((text.match(/Diagnostic-Code:\s*([^\n]+)/i) || [])[1] || (text.match(/(user unknown|no such user|does not exist|mailbox unavailable|address not found|invalid recipient|mailbox full|quota)/i) || [])[0] || '').trim();
  return { recipient: rec ? rec.toLowerCase() : '', code, diagnostic };
}

/** Is this automated / bulk mail (not a person writing)? Returns a reason or null. */
function automatedReason(msg) {
  const h = msg.headers;
  const as = String((h['auto-submitted'] || ['no'])[0]).toLowerCase();
  if (as && as !== 'no') return `Auto-Submitted: ${as}`;
  if (h['list-unsubscribe'] || h['list-id']) return 'mailing list / newsletter (List-Unsubscribe header)';
  const prec = String((h.precedence || [''])[0]).toLowerCase();
  if (['bulk', 'list', 'junk'].includes(prec)) return `Precedence: ${prec}`;
  if (h['x-autoreply'] || h['x-autorespond']) return 'auto-responder header';
  if (NOREPLY_RE.test(msg.from.email)) return `sent from a system address (${msg.from.email})`;
  return null;
}

/**
 * Classify a parsed message. ctx: { ownAddresses: Set, isSuppressed(email) }
 * Returns { category, reasons[], bounce?, autoReplyEligible }.
 */
function classify(msg, { ownAddresses = new Set(), ownDomains = new Set(), isSuppressed = () => null } = {}) {
  const from = msg.from.email;
  if (!from) return { category: 'automated', reasons: ['no sender address'], autoReplyEligible: false };
  if (ownAddresses.has(from)) return { category: 'own', reasons: ['sent from one of our own mailboxes'], autoReplyEligible: false };
  const domain = from.split('@')[1] || '';
  if (ownDomains.has(domain)) return { category: 'own', reasons: [`sent from our own domain ${domain} (site notifications, bookings, cPanel)`], autoReplyEligible: false };
  const b = bounceInfo(msg, ownAddresses);
  if (b) return { category: 'bounce', reasons: [`delivery failure${b.recipient ? ' for ' + b.recipient : ''}${b.code ? ' (' + b.code + ')' : ''}`], bounce: b, autoReplyEligible: false };
  if (AUTO_SUBJECT_RE.test(msg.subject) || /^(auto-replied|auto-generated)/i.test(String((msg.headers['auto-submitted'] || [''])[0]))) {
    return { category: 'auto_reply', reasons: ['out-of-office / automatic reply'], autoReplyEligible: false };
  }
  const own = msg.own || msg.body;
  const opt = optOutReason(own);
  if (opt) return { category: 'opt_out', reasons: [opt], autoReplyEligible: false };
  const esc = escalationReason(own, msg.subject);
  if (esc) return { category: 'escalate', reasons: [esc, 'a human must answer this'], autoReplyEligible: false };
  const sus = SUSPICIOUS_RE.find(re => re.test(msg.subject + '\n' + own));
  if (sus) return { category: 'suspicious', reasons: [`looks like phishing or spam (${(msg.subject + '\n' + own).match(sus)[0]})`], autoReplyEligible: false };
  const risky = msg.attachments.filter(a => /\.(html?|zip|rar|7z|exe|js|vbs|iso|img|docm|xlsm|scr)$/i.test(a.name || ''));
  if (risky.length) return { category: 'suspicious', reasons: [`risky attachment ${risky[0].name}`], autoReplyEligible: false };
  const auto = automatedReason(msg);
  if (auto) return { category: 'automated', reasons: [auto], autoReplyEligible: false };
  const sup = isSuppressed(from);
  if (sup) return { category: 'needs_reply', reasons: [`sender is on the do-not-contact list (${sup.value})`], autoReplyEligible: false };
  return { category: 'needs_reply', reasons: ['a person wrote'], autoReplyEligible: true };
}

/** Intents (decided by the agent) that may be answered automatically. From Harvey's AUTO_REPLY_INTENTS. */
const AUTO_REPLY_INTENTS = ['interested', 'question', 'objection', 'wrong_person', 'accepted_offer'];
const REPLY_INTENTS = [...AUTO_REPLY_INTENTS, 'other'];
const NO_REPLY_INTENTS = ['not_interested', 'unsubscribe', 'escalate', 'ooo'];

module.exports = { classify, optOutReason, escalationReason, bounceInfo, automatedReason, AUTO_REPLY_INTENTS, REPLY_INTENTS, NO_REPLY_INTENTS, OPT_OUT_PATTERNS, ESCALATION_PATTERNS };
