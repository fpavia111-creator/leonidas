'use strict';
/**
 * Decision log (agent-decision-memory style): every contact decision records WHY.
 * Append-only JSONL with a SHA-256 hash chain so edits/deletions are detectable.
 */
const crypto = require('crypto');

const FILE = 'audit.jsonl';
const ACTIONS = new Set(['lead_added', 'lead_scored', 'queued', 'blocked', 'approved', 'rejected', 'sent', 'send_blocked', 'send_failed', 'bounce', 'suppressed', 'unsuppressed', 'config']);

function hashRec(r) {
  const { hash, ...rest } = r;
  return crypto.createHash('sha256').update(JSON.stringify(rest)).digest('hex');
}

class AuditLog {
  constructor(store) { this.store = store; }
  all() { return this.store.readLines(FILE); }
  record({ action, leadId = null, messageId = null, actor = 'agent', reason, evidence = [], alternatives = [], data = {} }) {
    if (!ACTIONS.has(action)) throw new Error(`unknown audit action ${action}`);
    if (!reason || !String(reason).trim()) throw new Error('audit records require a reason (why)');
    const prev = this.all().slice(-1)[0];
    const rec = { ts: new Date().toISOString(), action, leadId, messageId, actor, reason: String(reason), evidence, alternatives, data, prev: prev ? prev.hash : null };
    rec.hash = hashRec(rec);
    this.store.append(FILE, rec);
    return rec;
  }
  forLead(leadId) { return this.all().filter(r => r.leadId === leadId); }
  verify() {
    const recs = this.all();
    let prev = null;
    for (let i = 0; i < recs.length; i++) {
      const r = recs[i];
      if (r.prev !== prev || hashRec(r) !== r.hash) return { ok: false, brokenAt: i, count: recs.length };
      prev = r.hash;
    }
    return { ok: true, count: recs.length };
  }
}

module.exports = { AuditLog, ACTIONS };
