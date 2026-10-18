'use strict';
/** Do-not-contact list: exact emails and whole domains. Matching normalizes case and +tags. */
function normalizeEmail(e) {
  e = String(e || '').trim().toLowerCase();
  const at = e.lastIndexOf('@');
  if (at < 0) return e;
  let local = e.slice(0, at);
  const plus = local.indexOf('+');
  if (plus > 0) local = local.slice(0, plus);
  return `${local}@${e.slice(at + 1)}`;
}

class Suppression {
  constructor(store) { this.store = store; this.name = 'suppression.json'; }
  list() { return this.store.readJson(this.name, []); }
  add(value, { reason = 'manual', source = 'user' } = {}) {
    value = String(value).trim().toLowerCase();
    const type = value.includes('@') ? 'email' : 'domain';
    if (type === 'email') value = normalizeEmail(value);
    else value = value.replace(/^@/, '');
    const items = this.list();
    if (!items.some(i => i.value === value)) {
      items.push({ type, value, reason, source, addedAt: new Date().toISOString() });
      this.store.writeJson(this.name, items);
    }
    return { type, value };
  }
  remove(value) {
    const v = String(value).trim().toLowerCase();
    const items = this.list();
    const kept = items.filter(i => i.value !== v && i.value !== normalizeEmail(v));
    this.store.writeJson(this.name, kept);
    return items.length - kept.length;
  }
  match(email) {
    const e = normalizeEmail(email);
    const domain = e.split('@')[1] || '';
    for (const i of this.list()) {
      if (i.type === 'email' && i.value === e) return i;
      if (i.type === 'domain' && (domain === i.value || domain.endsWith('.' + i.value))) return i;
    }
    return null;
  }
}

module.exports = { Suppression, normalizeEmail };
