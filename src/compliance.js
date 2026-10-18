'use strict';
/**
 * Deterministic pre-send compliance + content gate.
 * Content rules (banned phrases, merge tags, link budget, plain text) are ported from
 * Harvey's gate.py by Ethan Rogers (MIT). CAN-SPAM footer, suppression, role-address
 * and subject-length rules are Leonidas of the Web additions.
 */
const { normalizeEmail } = require('./suppression');

const BANNED_PHRASES = [
  'act now', 'buy now', 'click here', 'click below', 'limited time',
  'limited offer', 'exclusive deal', 'special offer', 'risk-free',
  'no obligation', '100% free', 'make money', 'double your',
  'guaranteed results', 'winner', 'congratulations',
  'i hope this finds you well', 'hope this email finds you well',
  'i hope this email finds you', 'picture this', 'what if i told you',
  "in today's fast-paced world", 'game-changer', 'game changer',
  'cutting-edge solution', 'revolutionize your', 'unlock your',
  'supercharge your', 'as an ai', "i'm an ai", 'i am an ai',
  'as a language model',
];

/** Hard rule from Kurt: cold-email subjects must be under 30 characters. */
const SUBJECT_MAX_EXCLUSIVE = 30;

const EMAIL_RE = /^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$/;
const MERGE_TAG_RE = /\{\{\s*\w+\s*\}\}|\{\s*\w+\s*\}(?!\})|\[\s*(first_?name|company|name)\s*\]/gi;
const URL_RE = /https?:\/\/\S+/gi;
const HTML_RE = /<\s*(html|body|div|table|img|a|span|p)\b/i;
const DECEPTIVE_SUBJECT_RE = /^\s*(re|fwd?|fw)\s*:/i;
const ROLE_LOCALPARTS = new Set(['abuse', 'postmaster', 'noreply', 'no-reply', 'donotreply', 'do-not-reply', 'mailer-daemon', 'webmaster', 'hostmaster', 'security']);

function subjectLimit(cfg) {
  const configured = cfg && cfg.compliance && Number(cfg.compliance.maxSubjectLength);
  // Config may tighten the limit but never loosen it past 29.
  return Math.min(configured || SUBJECT_MAX_EXCLUSIVE - 1, SUBJECT_MAX_EXCLUSIVE - 1);
}

function renderFooter(cfg) {
  const unsub = cfg.compliance.unsubscribe.url || (cfg.compliance.unsubscribe.mailto ? `mailto:${cfg.compliance.unsubscribe.mailto}?subject=unsubscribe` : '');
  return cfg.compliance.footerTemplate
    .replace('{company}', cfg.sender.company || cfg.sender.name || '')
    .replace('{physicalAddress}', cfg.sender.physicalAddress || '')
    .replace('{unsubscribe}', unsub);
}

function hasFooter(body, cfg) {
  const b = body.toLowerCase();
  const addr = (cfg.sender.physicalAddress || '').toLowerCase().trim();
  const unsubOk = /unsubscribe|opt[ -]?out/.test(b);
  const addrOk = !!addr && b.includes(addr);
  return { unsubOk, addrOk };
}

/**
 * Check one outgoing email. Returns {ok, errors[], warnings[]}.
 * opts: { cfg, suppression (Suppression instance), kind: 'cold'|'followup'|'reply', footerAppended }
 */
/** Cold email bodies must be UNDER 100 words (footer excluded). Config may tighten, never loosen. */
const BODY_MAX_WORDS_EXCLUSIVE = 100;
function bodyWordLimit(cfg) {
  const c = Number(cfg && cfg.compliance && cfg.compliance.maxBodyWords);
  const hard = BODY_MAX_WORDS_EXCLUSIVE - 1;
  return Number.isFinite(c) && c > 0 ? Math.min(Math.floor(c), hard) : hard;
}
/** Word count of the body excluding the appended compliance footer. */
function stripFooter(body, cfg) {
  body = String(body || '');
  try {
    const f = renderFooter(cfg).trim();
    if (f) { const i = body.lastIndexOf(f); if (i !== -1) return body.slice(0, i); }
  } catch (_) { /* fall through */ }
  const m = body.match(/^([\s\S]*?)\n--[ \t]*\n[\s\S]*$/);
  return m ? m[1] : body;
}
function countBodyWords(body, cfg) {
  return stripFooter(body, cfg).split(/\s+/).filter(Boolean).length;
}

function checkEmail({ to, subject, body }, opts) {
  const cfg = opts.cfg;
  const kind = opts.kind || 'cold';
  const errors = [];
  const warnings = [];
  subject = String(subject || '').trim();
  body = String(body || '').trim();
  const addr = normalizeEmail(to || '');

  if (!EMAIL_RE.test(String(to || '').trim())) errors.push(`invalid recipient address '${to}'`);
  const local = addr.split('@')[0];
  if (cfg.compliance.blockRoleAddresses && ROLE_LOCALPARTS.has(local)) errors.push(`role/system address '${to}' is never a valid cold-email recipient`);
  if (opts.suppression) {
    const hit = opts.suppression.match(addr);
    if (hit) errors.push(`recipient is on the do-not-contact list (${hit.type}: ${hit.value}, reason: ${hit.reason || 'n/a'})`);
  }

  if (/[\r\n]/.test(subject) || /[\r\n]/.test(String(to || ''))) errors.push('CR/LF in subject or recipient (header injection)');
  if (!subject) errors.push('empty subject');
  const limit = subjectLimit(cfg);
  if (kind !== 'reply' && subject.length > limit) {
    errors.push(`subject too long (${subject.length} chars; cold email subjects must be under ${SUBJECT_MAX_EXCLUSIVE})`);
  }
  if (kind === 'cold' && DECEPTIVE_SUBJECT_RE.test(subject)) errors.push('deceptive subject: "Re:/Fwd:" on a first-touch email (CAN-SPAM)');
  if (!body) errors.push('empty body');

  if (kind !== 'reply') {
    const words = countBodyWords(body, cfg);
    const max = bodyWordLimit(cfg);
    if (words > max) errors.push(`body too long (${words} words; cold email bodies must be under ${BODY_MAX_WORDS_EXCLUSIVE} words, max ${max}, excluding the compliance footer)`);
  }
  const leftover = [...new Set((subject + ' ' + body).match(MERGE_TAG_RE) || [])];
  if (leftover.length) errors.push(`unrendered merge tags: ${leftover.slice(0, 3).join(', ')}`);
  const lowered = (subject + ' ' + body).toLowerCase();
  const hits = BANNED_PHRASES.filter(p => lowered.includes(p));
  if (hits.length) errors.push(`banned phrases: ${hits.slice(0, 3).join(', ')}`);
  const links = (body.match(URL_RE) || []).filter(u => !isUnsubLink(u, cfg));
  if (links.length > cfg.compliance.maxLinks) errors.push(`too many links (${links.length} > ${cfg.compliance.maxLinks})`);
  if (!cfg.compliance.allowHtml && HTML_RE.test(body)) errors.push('HTML markup in body (plain text only)');
  if (/[A-Z]{6,}/.test(subject)) warnings.push('shouting (ALL CAPS) in subject');
  if ((subject.match(/!/g) || []).length > 0) warnings.push('exclamation mark in subject hurts deliverability');

  // CAN-SPAM: physical postal address + working opt-out on every commercial message.
  if (kind !== 'reply') {
    if (!cfg.sender.physicalAddress) errors.push('sender.physicalAddress not configured (CAN-SPAM requires a valid postal address)');
    if (!cfg.compliance.unsubscribe.url && !cfg.compliance.unsubscribe.mailto) errors.push('no unsubscribe url/mailto configured (CAN-SPAM opt-out)');
    if (!opts.footerAppended) {
      const f = hasFooter(body, cfg);
      if (!f.unsubOk) errors.push('body has no unsubscribe/opt-out line');
      if (cfg.sender.physicalAddress && !f.addrOk) errors.push('body does not include the physical postal address');
    }
  }
  return { ok: errors.length === 0, errors, warnings };
}

function isUnsubLink(u, cfg) {
  const url = cfg.compliance.unsubscribe.url;
  return !!url && u.startsWith(url);
}

module.exports = { BODY_MAX_WORDS_EXCLUSIVE, bodyWordLimit, countBodyWords, stripFooter, BANNED_PHRASES, SUBJECT_MAX_EXCLUSIVE, subjectLimit, renderFooter, hasFooter, checkEmail, ROLE_LOCALPARTS };
