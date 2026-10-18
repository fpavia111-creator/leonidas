'use strict';
/** Writer prompt handed to the host agent (Claude Code / Cursor / Codex) via MCP. */
const { SUBJECT_MAX_EXCLUSIVE, BANNED_PHRASES, BODY_MAX_WORDS_EXCLUSIVE } = require('./compliance');

function bookingLine(offer) {
  if (!offer) return null;
  const mins = offer.meetingDurationMinutes;
  const who = offer.meetingOwner ? ` with ${offer.meetingOwner}` : '';
  if (offer.bookingMethod === 'link' && offer.bookingUrl) return `- Call to action: a ${mins}-minute call${who}; you may include this one booking link: ${offer.bookingUrl}`;
  if (offer.bookingMethod === 'ask_preference') return `- Call to action: do NOT include a booking link. Ask one low-friction question, e.g. whether they'd rather get details by email, text, or a ${mins}-minute call${who}.`;
  return `- Call to action: ask for a reply (goal: ${offer.goal || 'get_reply'}); no booking link.`;
}

/** Context block from product/offer config. Keeps it short: the email has under 100 words. */
function contextLines(cfg, lead) {
  if (!cfg) return [];
  const p = cfg.product || {}, o = cfg.offer || {}, out = [];
  if (cfg.sender && cfg.sender.tone) out.push(`- Tone: ${cfg.sender.tone}.`);
  if (p.name || p.description) out.push(`Product: ${[p.name, p.description].filter(Boolean).join(' - ')}`);
  if (p.pricing) out.push(`Pricing (quote exactly, never invent other prices): ${p.pricing}`);
  if (o.entry) out.push(`Entry offer to mention: ${o.entry}`);
  if (o.primary) out.push(`Offer guidance: ${o.primary}`);
  const benefits = pickBenefits(p.keyBenefits || [], lead, 3);
  if (benefits.length) out.push(`Pick at most ONE benefit that fits this lead: ${benefits.map(b => `"${b}"`).join('; ')}`);
  const b = bookingLine(o); if (b) out.push(b);
  if (cfg.sending && cfg.sending.personalizeFirstEmail !== false && (!lead.signals || !lead.signals.length) && !lead.notes) out.push('- WARNING: no lead signals/notes; personalization is required, so research the lead first rather than sending a generic email.');
  else if (cfg.sending && cfg.sending.personalizeFirstEmail !== false) out.push('- Personalize: the first line must reference this specific business.');
  return out;
}

/** Rank benefits by word overlap with lead industry/signals/notes (deterministic). */
function pickBenefits(list, lead, n) {
  const words = new Set(`${lead.industry || ''} ${(lead.signals || []).join(' ')} ${lead.notes || ''}`.toLowerCase().match(/[a-z]{4,}/g) || []);
  return list.map((b, i) => ({ b, i, s: (b.toLowerCase().match(/[a-z]{4,}/g) || []).filter(w => words.has(w)).length }))
    .sort((x, y) => y.s - x.s || x.i - y.i).slice(0, n).map(x => x.b);
}

function writerPrompt({ lead, icp, sender, kind = 'cold', cfg }) {
  return [
    `Write one ${kind === 'cold' ? 'first-touch cold' : 'follow-up'} email from ${sender.name || 'the sender'} at ${sender.company || 'the company'} to ${lead.name || 'the contact'} (${lead.title || 'n/a'}) at ${lead.company || 'their company'}.`,
    'HARD RULES (the send gate rejects violations):',
    `- Subject line MUST be under ${SUBJECT_MAX_EXCLUSIVE} characters (${SUBJECT_MAX_EXCLUSIVE - 1} max), lowercase-casual is fine, no "Re:"/"Fwd:" on first touch, no exclamation marks.`,
    `- Body MUST be under ${BODY_MAX_WORDS_EXCLUSIVE} words (${BODY_MAX_WORDS_EXCLUSIVE - 1} max, not counting the footer). Count them; if over, cut. Plain text, at most one link, no merge tags left unrendered.`,
    '- Reference one specific, true observation about the company. No invented facts.',
    `- Never use: ${BANNED_PHRASES.slice(0, 12).join(', ')}, ...`,
    '- Do NOT write the unsubscribe/address footer; Leonidas appends it.',
    `Lead facts: ${JSON.stringify({ industry: lead.industry, signals: lead.signals || [], notes: lead.notes || '' })}`,
    ...contextLines(cfg, lead),
    `ICP: ${icp.id}. Return JSON: {"subject": "...", "body": "...", "why": "one sentence on why this lead, citing a signal"}.`,
  ].join('\n');
}

module.exports = { writerPrompt, pickBenefits, bookingLine };
