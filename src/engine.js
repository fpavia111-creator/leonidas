'use strict';
/**
 * Leonidas of the Web engine: leads -> scored -> drafted -> gated -> human-approved -> sent.
 * Nothing is delivered unless sending.mode === "send" AND the message was approved
 * (by a human unless approval.allowAgentApproval is explicitly true).
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { Store, newId } = require('./store');
const { loadConfig, stateDir, sendReadiness } = require('./config');
const { Suppression, normalizeEmail } = require('./suppression');
const { AuditLog } = require('./audit');
const { checkEmail, renderFooter } = require('./compliance');
const { canSend, classifyBounce, bounceStats, dayKey, effectiveDailyCap, allowedDays, isQuietHours } = require('./deliverability');
const { resolveIcp, scoreLead } = require('./icp');

/** A lead counts as verified if a verifier marked it so (emailVerified true or verification "valid"/"verified"). */
function isVerified(lead) {
  return lead.emailVerified === true || ['valid', 'verified', 'deliverable'].includes(String(lead.verification || '').toLowerCase());
}

class Leadwright {
  constructor({ dir = stateDir(), cfg, now } = {}) {
    this.dir = dir;
    this.store = new Store(dir);
    this.cfg = cfg || loadConfig(dir);
    this.suppression = new Suppression(this.store);
    this.audit = new AuditLog(this.store);
    this.now = now || (() => new Date());
  }

  leads() { return this.store.readJson('leads.json', []); }
  outbox() { return this.store.readJson('outbox.json', []); }
  sendLog() { return this.store.readLines('sends.jsonl'); }
  bounces() { return this.store.readJson('bounces.json', []); }
  _saveLeads(l) { this.store.writeJson('leads.json', l); }
  _saveOutbox(o) { this.store.writeJson('outbox.json', o); }
  icp() { return resolveIcp(this.cfg.icp); }

  addLeads(list, { source = 'agent', reason } = {}) {
    const leads = this.leads();
    const added = [], skipped = [];
    for (const raw of list) {
      const email = normalizeEmail(raw.email);
      if (!email) { skipped.push({ lead: raw, why: 'missing email' }); continue; }
      if (leads.some(l => l.email === email)) { skipped.push({ email, why: 'duplicate' }); continue; }
      const sup = this.suppression.match(email);
      if (sup) { skipped.push({ email, why: `do-not-contact (${sup.value})` }); continue; }
      const lead = { id: newId('lead'), ...raw, email, source, createdAt: this.now().toISOString(), status: 'new' };
      const sc = scoreLead(lead, this.icp());
      Object.assign(lead, { score: sc.score, qualified: sc.qualified, scoreReasons: sc.reasons });
      leads.push(lead);
      added.push(lead);
      this.audit.record({ action: 'lead_added', leadId: lead.id, actor: source, reason: reason || raw.why || `added from ${source}`, evidence: sc.reasons, data: { score: sc.score, qualified: sc.qualified } });
    }
    this._saveLeads(leads);
    return { added, skipped };
  }

  getLead(idOrEmail) {
    const e = normalizeEmail(idOrEmail);
    return this.leads().find(l => l.id === idOrEmail || l.email === e) || null;
  }

  /** Gate + queue a draft. `why` is mandatory: the audit log must say why this lead is contacted. */
  queueEmail({ leadId, subject, body, why, evidence = [], kind = 'cold', actor = 'agent' }) {
    const lead = this.getLead(leadId);
    if (!lead) throw new Error(`unknown lead ${leadId}`);
    if (!why || !String(why).trim()) throw new Error('queue_email requires "why": the reason this lead is being contacted');
    const fullBody = String(body || '').trim() + renderFooter(this.cfg);
    const gate = checkEmail({ to: lead.email, subject, body: fullBody }, { cfg: this.cfg, suppression: this.suppression, kind, footerAppended: false });
    if (kind === 'cold' && !lead.qualified) gate.warnings.push(`lead score ${lead.score} below ICP minimum ${this.icp().minScore}`);
    const msg = {
      id: newId('msg'), leadId: lead.id, to: lead.email, subject: String(subject || '').trim(), body: fullBody, kind,
      why, evidence, status: gate.ok ? 'pending_approval' : 'blocked', gate, createdAt: this.now().toISOString(),
      approvedBy: null, approvedAt: null,
    };
    const ob = this.outbox(); ob.push(msg); this._saveOutbox(ob);
    this.audit.record({ action: gate.ok ? 'queued' : 'blocked', leadId: lead.id, messageId: msg.id, actor, reason: gate.ok ? why : `gate: ${gate.errors.join('; ')}`, evidence: [...evidence, ...lead.scoreReasons || []], data: { subject: msg.subject, warnings: gate.warnings, intendedWhy: why } });
    return msg;
  }

  _update(id, fn) {
    const ob = this.outbox();
    const m = ob.find(x => x.id === id);
    if (!m) throw new Error(`unknown message ${id}`);
    fn(m); this._saveOutbox(ob); return m;
  }

  approve(id, { actor = 'human', note = '' } = {}) {
    if (actor !== 'human' && !this.cfg.approval.allowAgentApproval) {
      throw new Error('approval by an agent is disabled (approval.allowAgentApproval=false). A human must run: leonidas approve ' + id);
    }
    const m = this._update(id, m => {
      if (m.status !== 'pending_approval') throw new Error(`message ${id} is ${m.status}, not pending_approval`);
      m.status = 'approved'; m.approvedBy = actor; m.approvedAt = this.now().toISOString();
    });
    this.audit.record({ action: 'approved', leadId: m.leadId, messageId: id, actor, reason: note || 'approved for sending', data: { why: m.why } });
    return m;
  }

  reject(id, { actor = 'human', reason = 'rejected' } = {}) {
    const m = this._update(id, m => { m.status = 'rejected'; });
    this.audit.record({ action: 'rejected', leadId: m.leadId, messageId: id, actor, reason });
    return m;
  }

  /** Send approved messages that pass every live check. Returns per-message results. */
  sendApproved({ actor = 'human', ids } = {}) {
    const results = [];
    const ready = sendReadiness(this.cfg);
    const now = this.now();
    for (const m of this.outbox()) {
      if (ids && !ids.includes(m.id)) continue;
      if (m.status !== 'approved' && m.status !== 'scheduled') continue;
      if (m.status === 'scheduled' && m.sendAfter && dayKey(now, this._tz(m)) < m.sendAfter) { results.push({ id: m.id, status: 'scheduled', sendAfter: m.sendAfter }); continue; }
      if (this.cfg.approval.required && !m.approvedBy) { results.push({ id: m.id, status: 'skipped', reasons: ['not approved'] }); continue; }
      const reasons = [...ready];
      const recheck = checkEmail(m, { cfg: this.cfg, suppression: this.suppression, kind: m.kind });
      reasons.push(...recheck.errors);
      const lead = this.getLead(m.leadId) || {};
      if (m.kind !== 'reply' && !this.cfg.sending.sendUnverified && !isVerified(lead)) reasons.push(`recipient ${m.to} is not verified (sending.sendUnverified=false); verify it and set lead.emailVerified=true`);
      const cs = canSend(this.cfg, { sendLog: this.sendLog(), bounces: this.bounces(), email: m.to, now, recipientTz: lead.timezone });
      if (cs.dayBlocked && reasons.length === 0) {
        this._update(m.id, x => { x.status = 'scheduled'; x.sendAfter = cs.sendAfter; });
        this.audit.record({ action: 'send_blocked', leadId: m.leadId, messageId: m.id, actor, reason: cs.reasons[0], data: { sendAfter: cs.sendAfter } });
        results.push({ id: m.id, status: 'scheduled', sendAfter: cs.sendAfter, reasons: cs.reasons });
        continue;
      }
      reasons.push(...cs.reasons);
      if (reasons.length) {
        this.audit.record({ action: 'send_blocked', leadId: m.leadId, messageId: m.id, actor, reason: reasons.join('; ') });
        results.push({ id: m.id, status: 'held', reasons });
        continue;
      }
      let transportId;
      try { transportId = this._deliver(m); } catch (e) {
        const permanent = !!e.permanent;
        if (permanent && /RCPT/.test(e.stage || '')) this.recordBounce({ email: m.to, code: String(e.code), diagnostic: e.message, actor: 'system' });
        if (permanent) this._update(m.id, x => { x.status = 'failed'; x.error = e.message; });
        this.audit.record({ action: 'send_failed', leadId: m.leadId, messageId: m.id, actor, reason: e.message, data: { code: e.code || null, stage: e.stage || null, permanent } });
        results.push({ id: m.id, status: permanent ? 'failed' : 'retry', reasons: [e.message] });
        continue;
      }
      const day = cs.day;
      this.store.append('sends.jsonl', { id: m.id, to: m.to, day, ts: now.toISOString(), status: 'sent', transportId });
      this._update(m.id, x => { x.status = 'sent'; x.sentAt = now.toISOString(); });
      this.audit.record({ action: 'sent', leadId: m.leadId, messageId: m.id, actor, reason: m.why, data: { transport: this.cfg.sending.transport, approvedBy: m.approvedBy } });
      results.push({ id: m.id, status: 'sent' });
    }
    return results;
  }

  _tz(m) { const l = this.getLead(m.leadId); return (l && l.timezone) || this.cfg.sending.timezone; }

  _eml(m) {
    const s = this.cfg.sender;
    const unsub = this.cfg.compliance.unsubscribe;
    const lu = [unsub.mailto && `<mailto:${unsub.mailto}?subject=unsubscribe>`, unsub.url && `<${unsub.url}>`].filter(Boolean).join(', ');
    const headers = [`From: ${s.name ? `"${s.name}" ` : ''}<${s.email}>`, `To: <${m.to}>`, `Subject: ${m.subject}`, lu && `List-Unsubscribe: ${lu}`, unsub.url && 'List-Unsubscribe-Post: List-Unsubscribe=One-Click', `X-Leadwright-Id: ${m.id}`, 'Content-Type: text/plain; charset=utf-8'].filter(Boolean);
    return headers.join('\r\n') + '\r\n\r\n' + m.body.replace(/\r?\n/g, '\r\n') + '\r\n';
  }

  _deliver(m) {
    const eml = this._eml(m);
    if (this.cfg.sending.transport === 'smtp') {
      // SMTP is async; run it in a short-lived child so the send loop stays synchronous and sequential.
      const { resolveSmtp } = require('./smtp');
      const smtp = resolveSmtp(this.cfg);
      const outp = execFileSync(process.execPath, [path.join(__dirname, 'smtp-worker.js')], {
        input: JSON.stringify({ smtp, envelope: { from: this.cfg.sender.email, to: m.to }, eml }),
        env: process.env, timeout: (smtp.timeoutMs || 30000) * 3, encoding: 'utf8',
      });
      const r = JSON.parse(outp);
      if (!r.ok) { const e = new Error(`smtp ${r.stage || ''}: ${r.error}`.trim()); e.code = r.code; e.stage = r.stage; e.permanent = r.permanent; throw e; }
      return `smtp:${r.code} ${String(r.response || '').slice(0, 120)}`;
    }
    if (this.cfg.sending.transport === 'command') {
      const [cmd, ...args] = this.cfg.sending.command.split(/\s+/).filter(Boolean);
      execFileSync(cmd, args, { input: eml });
      return 'command';
    }
    const dir = path.join(this.dir, 'sent');
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, `${m.id}.eml`);
    fs.writeFileSync(f, eml);
    return f;
  }

  recordBounce({ email, code = '', diagnostic = '', actor = 'system' }) {
    const type = classifyBounce(code, diagnostic);
    const e = normalizeEmail(email);
    const b = this.bounces(); b.push({ email: e, type, code, diagnostic, ts: this.now().toISOString() });
    this.store.writeJson('bounces.json', b);
    const lead = this.getLead(e);
    if (type === 'hard' || type === 'complaint') {
      this.suppression.add(e, { reason: `${type} bounce ${code}`.trim(), source: 'bounce' });
      this.audit.record({ action: 'suppressed', leadId: lead && lead.id, actor, reason: `${type} bounce: ${diagnostic || code}` });
    }
    this.audit.record({ action: 'bounce', leadId: lead && lead.id, actor, reason: `${type} bounce`, data: { code, diagnostic } });
    return { type, suppressed: type !== 'soft' };
  }

  suppress(value, { reason = 'manual', actor = 'human' } = {}) {
    const r = this.suppression.add(value, { reason, source: actor });
    const lead = r.type === 'email' ? this.getLead(r.value) : null;
    this.audit.record({ action: 'suppressed', leadId: lead && lead.id, actor, reason, data: r });
    // Pull any pending mail to that recipient.
    const ob = this.outbox();
    for (const m of ob) if (['pending_approval', 'approved', 'scheduled'].includes(m.status) && this.suppression.match(m.to)) m.status = 'blocked';
    this._saveOutbox(ob);
    return r;
  }

  /** Why was / is this lead contacted? Full decision trail. */
  why(idOrEmail) {
    const lead = this.getLead(idOrEmail);
    if (!lead) return null;
    return { lead: { id: lead.id, email: lead.email, company: lead.company, score: lead.score, scoreReasons: lead.scoreReasons }, messages: this.outbox().filter(m => m.leadId === lead.id).map(m => ({ id: m.id, status: m.status, subject: m.subject, why: m.why })), trail: this.audit.forLead(lead.id) };
  }

  status() {
    const now = this.now();
    const day = dayKey(now, this.cfg.sending.timezone);
    const counts = {};
    for (const m of this.outbox()) counts[m.status] = (counts[m.status] || 0) + 1;
    const cs = canSend(this.cfg, { sendLog: this.sendLog(), bounces: this.bounces(), email: 'x@example.invalid', now });
    return { mode: this.cfg.sending.mode, sendReadiness: sendReadiness(this.cfg), leads: this.leads().length, outbox: counts, today: day, sentToday: cs.used, capToday: effectiveDailyCap(this.cfg, day), allowedDays: allowedDays(this.cfg), sendWindow: this.cfg.sending.window, quietHoursNow: isQuietHours(this.cfg, now), usageBudgetPercent: this.cfg.usage.maxDailyBrainPercent, approvalRequired: this.cfg.approval.required, sendUnverified: this.cfg.sending.sendUnverified, sendDayToday: !cs.dayBlocked, nextSendDay: cs.sendAfter || day, bounces: bounceStats(this.sendLog(), this.bounces()), suppressed: this.suppression.list().length, audit: this.audit.verify() };
  }
}

/** New name; Leadwright stays as a deprecated alias. */
const Leonidas = Leadwright;
module.exports = { Leonidas, Leadwright, isVerified };
