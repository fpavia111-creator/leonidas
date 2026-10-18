'use strict';
/**
 * Zero-dependency MCP server (stdio, JSON-RPC 2.0, newline-delimited) for Claude Code,
 * Cursor and Codex. The agent can research, score, draft and queue. It cannot approve
 * (unless approval.allowAgentApproval=true) and cannot send unless sending.mode="send".
 */
const readline = require('readline');
const { Leadwright } = require('./engine');
const { listTemplates } = require('./icp');
const { checkEmail, renderFooter } = require('./compliance');
const { checkDomainAuth } = require('./deliverability');
const { writerPrompt } = require('./prompts');
const { matchObjection } = require('./objections');
const { toCsv } = require('./export');
const pkg = require('../package.json');

const obj = (props, required = []) => ({ type: 'object', properties: props, required });
const S = { type: 'string' };

const TOOLS = [
  { name: 'leo_status', description: 'Pipeline status: send mode, caps, warmup, allowed send days (Tue/Wed), bounce rate, outbox counts, audit-chain integrity.', inputSchema: obj({}) },
  { name: 'leo_icp_templates', description: 'List the industry ICP templates (SaaS, agencies, home services, clinics, e-commerce, real estate, professional services, manufacturing).', inputSchema: obj({}) },
  { name: 'leo_add_leads', description: 'Add leads (deduped, do-not-contact filtered, ICP-scored). Each lead: email, name, title, company, industry, employees, location, timezone, signals[], notes, why.', inputSchema: obj({ leads: { type: 'array', items: { type: 'object' } }, reason: S }, ['leads']) },
  { name: 'leo_list_leads', description: 'List leads, optionally only qualified ones.', inputSchema: obj({ qualifiedOnly: { type: 'boolean' } }) },
  { name: 'leo_writer_prompt', description: 'Get the drafting brief for a lead (includes the hard rules: subject under 30 chars, plain text, one link).', inputSchema: obj({ leadId: S, kind: S }, ['leadId']) },
  { name: 'leo_check_email', description: 'Dry-run the compliance/deliverability gate on a draft without queueing it.', inputSchema: obj({ to: S, subject: S, body: S, kind: S }, ['to', 'subject', 'body']) },
  { name: 'leo_queue_email', description: 'Gate and queue a draft for HUMAN approval. "why" (reason this lead is contacted) is required and goes to the audit log. Footer is appended automatically.', inputSchema: obj({ leadId: S, subject: S, body: S, why: S, evidence: { type: 'array', items: S }, kind: S }, ['leadId', 'subject', 'body', 'why']) },
  { name: 'leo_list_outbox', description: 'List outbox messages, optionally by status (pending_approval, approved, scheduled, blocked, sent, rejected).', inputSchema: obj({ status: S }) },
  { name: 'leo_approve', description: 'Approve a message. Disabled for agents by default; a human runs `leonidas approve <id>`.', inputSchema: obj({ id: S, note: S }, ['id']) },
  { name: 'leo_reject', description: 'Reject a queued message.', inputSchema: obj({ id: S, reason: S }, ['id']) },
  { name: 'leo_send_approved', description: 'Deliver approved messages that pass all live checks (send mode, caps, warmup, Tue/Wed only, bounce breaker, suppression). Off-day messages are scheduled for the next allowed day.', inputSchema: obj({ ids: { type: 'array', items: S } }) },
  { name: 'leo_suppress', description: 'Add an email or whole domain to the do-not-contact list (pulls pending mail).', inputSchema: obj({ value: S, reason: S }, ['value']) },
  { name: 'leo_record_bounce', description: 'Record a bounce; hard bounces and complaints auto-suppress the address.', inputSchema: obj({ email: S, code: S, diagnostic: S }, ['email']) },
  { name: 'leo_why', description: 'Explain why a lead was contacted: score reasons, messages, and the full audit trail.', inputSchema: obj({ lead: S }, ['lead']) },
  { name: 'leo_audit_log', description: 'Recent audit-log entries and hash-chain verification.', inputSchema: obj({ limit: { type: 'number' } }) },
  { name: 'leo_export_csv', description: 'Export leads as CSV (formula-injection safe).', inputSchema: obj({}) },
  { name: 'leo_objection', description: 'Look up the configured response to a prospect objection (product.objectionResponses). Returns the closest match or null; never invent claims beyond it.', inputSchema: obj({ text: S }, ['text']) },
  { name: 'leo_dns_check', description: 'Check SPF / DMARC (and DKIM with a selector) for a sending domain.', inputSchema: obj({ domain: S, dkimSelector: S }, ['domain']) },
];

/** 0.1.x tool names (lw_*) keep working as deprecated aliases of leo_*. */
const canonicalTool = name => String(name).replace(/^lw_/, 'leo_');

async function callTool(lw, name, a = {}) {
  switch (canonicalTool(name)) {
    case 'leo_status': return lw.status();
    case 'leo_icp_templates': return listTemplates();
    case 'leo_add_leads': { const r = lw.addLeads(a.leads || [], { source: 'agent', reason: a.reason }); return { added: r.added.map(l => ({ id: l.id, email: l.email, score: l.score, qualified: l.qualified })), skipped: r.skipped }; }
    case 'leo_list_leads': return lw.leads().filter(l => !a.qualifiedOnly || l.qualified);
    case 'leo_writer_prompt': { const lead = lw.getLead(a.leadId); if (!lead) throw new Error('unknown lead'); return { prompt: writerPrompt({ lead, icp: lw.icp(), sender: lw.cfg.sender, kind: a.kind, cfg: lw.cfg }) }; }
    case 'leo_check_email': return checkEmail({ to: a.to, subject: a.subject, body: String(a.body || '') + renderFooter(lw.cfg) }, { cfg: lw.cfg, suppression: lw.suppression, kind: a.kind || 'cold' });
    case 'leo_queue_email': return lw.queueEmail({ ...a, actor: 'agent' });
    case 'leo_list_outbox': return lw.outbox().filter(m => !a.status || m.status === a.status);
    case 'leo_approve': return lw.approve(a.id, { actor: 'agent', note: a.note });
    case 'leo_reject': return lw.reject(a.id, { actor: 'agent', reason: a.reason || 'rejected by agent' });
    case 'leo_send_approved': return lw.sendApproved({ actor: 'agent', ids: a.ids });
    case 'leo_suppress': return lw.suppress(a.value, { reason: a.reason || 'requested', actor: 'agent' });
    case 'leo_record_bounce': return lw.recordBounce({ ...a, actor: 'agent' });
    case 'leo_why': return lw.why(a.lead) || { error: 'unknown lead' };
    case 'leo_audit_log': return { verify: lw.audit.verify(), entries: lw.audit.all().slice(-(a.limit || 50)) };
    case 'leo_export_csv': return { csv: toCsv(lw.leads()) };
    case 'leo_objection': return matchObjection(lw.cfg.product.objectionResponses, a.text) || { match: null, note: 'no configured response; escalate to a human' };
    case 'leo_dns_check': return checkDomainAuth(a.domain, { dkimSelector: a.dkimSelector });
    default: throw new Error(`unknown tool ${name}`);
  }
}

async function handle(msg, makeLw) {
  const { id, method, params = {} } = msg;
  const ok = result => ({ jsonrpc: '2.0', id, result });
  if (method === 'initialize') return ok({ protocolVersion: params.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'leonidas', version: pkg.version } });
  if (method === 'ping') return ok({});
  if (method === 'tools/list') return ok({ tools: TOOLS });
  if (method === 'tools/call') {
    try {
      const r = await callTool(makeLw(), params.name, params.arguments || {});
      return ok({ content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] });
    } catch (e) {
      return ok({ content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true });
    }
  }
  if (id === undefined) return null; // notification
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } };
}

function serve({ input = process.stdin, output = process.stdout, makeLw = () => new Leadwright() } = {}) {
  const rl = readline.createInterface({ input });
  rl.on('line', async line => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { output.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }) + '\n'); return; }
    const res = await handle(msg, makeLw);
    if (res) output.write(JSON.stringify(res) + '\n');
  });
  return rl;
}

module.exports = { canonicalTool, TOOLS, callTool, handle, serve };
