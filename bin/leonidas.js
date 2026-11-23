#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const { Leadwright, isVerified } = require('../src/engine');
const { DEFAULTS, stateDir, saveConfig, loadConfig, configPath } = require('../src/config');
const { listTemplates } = require('../src/icp');
const { toCsv, parseCsv } = require('../src/export');
const { checkDomainAuth } = require('../src/deliverability');

const HELP = `Leonidas of the Web (leonidas) - compliance-first outbound sales pipeline for coding agents (MCP)

Usage: leonidas <command> [args]   ("leadwright" still works but is deprecated)
  init [--icp <template>]        create .leonidas/config.json (draft mode, human approval)
  mcp                            run the MCP server on stdio (Claude Code / Cursor / Codex)
  install-snippets               print MCP config for Claude Code, Cursor and Codex
  status                         caps, warmup, Tue/Wed send window, bounce rate, outbox
  templates                      list industry ICP templates
  import <file.csv>              add leads from CSV (email,name,title,company,industry,...)
  export                         leads as CSV on stdout
  outbox [status]                list queued messages
  show <msgId>                   print a queued message
  approve <msgId> [note]         HUMAN approval of one message
  reject <msgId> [reason]
  send                           deliver approved mail that passes every check
  send --watch [seconds]         keep running: try again every N seconds (default 10), sending as limits allow (Ctrl+C stops)
  verify [--all]                 check every new lead's domain can receive mail; ones that can't go to do-not-contact
  suppress <email|domain> [why]  add to do-not-contact list
  unsuppress <email|domain>
  bounce <email> [code] [diag]   record a bounce (hard -> auto-suppress)
  why <leadId|email>             why was this lead contacted?
  audit [--verify]               audit log / hash-chain check
  dns <domain> [dkimSelector]    SPF / DMARC / DKIM check
  config check [file]            validate a config (.json/.yaml; default $LEONIDAS_CONFIG or .leonidas/config.*)
  mailboxes test                 log in to every sending mailbox over SMTP and log out (sends nothing)
  inbox check                    read new mail (read-only): opt-outs suppressed, bounces recorded,
                                 the rest sorted for the agent to answer
  inbox [status]                 list inbox messages (new, needs_human, reply_queued, replied, ...)
  inbox show <id>                print one inbox message
  inbox close <id> [note]        close an inbox message without replying
  inbox escalate <id> [note]     hand an inbox message to a human
  inbox reply <id> <intent> <file|->  queue (or, with inbox.autoReply, send) the reply in file / stdin
  inbox test                     log in to every inbox account and list the folders it checks (reads nothing)
  import-harvey <in.yaml> [out]  convert a Harvey-style YAML config to Leonidas YAML (stdout if no out)
  import-harvey-contacts <csv>   add leads from a Harvey contacts export; opt-outs and invalid addresses
                                 go to do-not-contact, prospects Harvey already emailed are left out`;

const out = x => console.log(typeof x === 'string' ? x : JSON.stringify(x, null, 2));

/**
 * `send --watch`: a long-running sender. Each pass reloads the config and, unless a limit
 * holds every message (window, quiet hours, caps, send interval, bounce pause), runs one
 * send pass. Prints only deliveries, failures and changes of the waiting reason.
 */
async function watchSend(seconds, { passes = Infinity, log = console.log, now } = {}) {
  const { canSend } = require('../src/deliverability');
  const { sendReadiness } = require('../src/config');
  const every = Math.max(1, Number(seconds) || 10) * 1000;
  let last = '';
  for (let n = 0; n < passes; n++) {
    if (n) await new Promise(r => setTimeout(r, every));
    const lw = new Leadwright({ cfg: loadConfig(), now });
    const at = lw.now();
    const waiting = lw.outbox().some(m => m.status === 'approved' || m.status === 'scheduled');
    const ready = sendReadiness(lw.cfg);
    const cs = canSend(lw.cfg, { sendLog: lw.sendLog(), bounces: lw.bounces(), email: 'x@example.invalid', now: at });
    const idle = !waiting ? 'nothing approved to send' : ready.length ? `not ready to send: ${ready[0]}` : cs.global.length ? `waiting: ${cs.global[0]}` : '';
    if (idle) {
      if (idle.replace(/\d+/g, '#') !== last) log(`${at.toISOString()} ${idle}`);
      last = idle.replace(/\d+/g, '#');
      continue;
    }
    last = '';
    for (const r of lw.sendApproved({ actor: 'human' })) {
      const show = ['sent', 'failed', 'retry', 'busy'].includes(r.status) || (r.status === 'held' && r.fresh);
      if (show) log(`${at.toISOString()} ${r.status}${r.id ? ` ${r.id}` : ''}${r.mailbox ? ` from ${r.mailbox}` : ''}${r.status !== 'sent' && r.reasons ? `: ${r.reasons.join('; ')}` : ''}`);
    }
  }
}

async function main(argv) {
  const [cmd, ...a] = argv;
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') return out(HELP);
  if (cmd === '--version') return out(require('../package.json').version);
  if (cmd === 'mcp') { require('../src/mcp').serve(); return; }
  if (cmd === 'init') {
    const dir = stateDir();
    if (fs.existsSync(configPath(dir))) return out(`already initialized: ${configPath(dir)}`);
    const cfg = JSON.parse(JSON.stringify(DEFAULTS));
    const i = a.indexOf('--icp'); if (i >= 0) cfg.icp.template = a[i + 1];
    cfg.sending.warmup.startDate = new Date().toISOString().slice(0, 10);
    saveConfig(cfg, dir);
    return out(`created ${configPath(dir)}\nSending is OFF (mode "draft"). Fill in sender.*, compliance.unsubscribe, then set sending.mode="send" when ready.\nCold email only goes out Tue/Wed (${cfg.sending.timezone}); subjects must be under 30 chars.`);
  }
  if (cmd === 'install-snippets') {
    const bin = 'npx -y @kurtfrancisco/leonidas mcp';
    return out(`Claude Code:\n  claude mcp add leonidas -- ${bin}\n\nCursor (.cursor/mcp.json):\n  {"mcpServers":{"leonidas":{"command":"npx","args":["-y","@kurtfrancisco/leonidas","mcp"]}}}\n\nCodex (~/.codex/config.toml):\n  [mcp_servers.leonidas]\n  command = "npx"\n  args = ["-y", "@kurtfrancisco/leonidas", "mcp"]`);
  }
  if (cmd === 'templates') return out(listTemplates().map(t => `${t.id.padEnd(22)} ${t.label}`).join('\n'));
  if (cmd === 'config' && a[0] === 'check') {
    const { readConfigFile, findConfigFile, validateConfig, deepMerge } = require('../src/config');
    const file = a[1] || findConfigFile(stateDir());
    if (!file) throw new Error('no config file found');
    const r = readConfigFile(path.resolve(file));
    const v = validateConfig(deepMerge(DEFAULTS, r.user));
    out({ file, errors: v.errors, warnings: [...r.warnings, ...v.warnings] });
    if (v.errors.length) process.exitCode = 1;
    return;
  }
  if (cmd === 'import-harvey') {
    const yaml = require('../src/yaml');
    const r = yaml.parse(fs.readFileSync(path.resolve(a[0]), 'utf8'));
    const { config, notes } = require('../src/harvey').fromHarvey(r.value);
    const text = yaml.stringify(config);
    for (const n of [...r.warnings.map(w => w.message), ...notes]) console.error(`note: ${n}`);
    if (a[1]) { fs.writeFileSync(path.resolve(a[1]), text, { mode: 0o600 }); return out(`wrote ${a[1]}`); }
    return process.stdout.write(text);
  }
  if (cmd === 'dns') return out(await checkDomainAuth(a[0], { dkimSelector: a[1] }));
  if (cmd === 'mailboxes' && a[0] === 'test') {
    const { mailboxes } = require('../src/deliverability');
    const { resolveSmtp, verifyLogin } = require('../src/smtp');
    const cfg = loadConfig();
    if (cfg.sending.transport !== 'smtp') throw new Error('sending.transport is not "smtp": there is no mailbox to log in to');
    const d = a.indexOf('--delay'), delay = d >= 0 ? Number(a[d + 1]) || 0 : 2000; // shared hosts throttle rapid logins
    const list = mailboxes(cfg);
    const lw = new Leadwright({ cfg });
    let bad = 0;
    for (const [n, mb] of list.entries()) {
      if (n && delay) await new Promise(r => setTimeout(r, delay));
      const smtp = resolveSmtp({ sending: { smtp: mb.smtp } });
      try {
        const r = await verifyLogin(smtp);
        lw._restMailbox(mb.email, null); // a working login ends a rest from an earlier failure
        out(`ok    ${mb.email}  (${smtp.host}:${smtp.port}${r.encrypted ? ', encrypted' : ''})`);
      } catch (e) { bad++; out(`FAIL  ${mb.email}  (${smtp.host}:${smtp.port}) ${e.message}`); }
    }
    out(`${list.length - bad}/${list.length} mailboxes can log in. Nothing was sent.`);
    if (bad) process.exitCode = 1;
    return;
  }
  const lw = new Leadwright({ cfg: loadConfig() });
  switch (cmd) {
    case 'status': return out(lw.status());
    case 'import-harvey-contacts': {
      const { leads, suppress, skipped } = require('../src/harvey').fromHarveyContacts(parseCsv(fs.readFileSync(path.resolve(a[0]), 'utf8')));
      for (const s of suppress) if (!lw.suppression.match(s.email)) lw.suppress(s.email, { reason: s.reason, actor: 'human' });
      const r = lw.addLeads(leads, { source: 'harvey', reason: `imported from Harvey export ${path.basename(a[0])}` });
      return out({ added: r.added.length, verified: r.added.filter(l => isVerified(l)).length, doNotContact: suppress.length, leftOut: skipped, skipped: r.skipped.length });
    }
    case 'import': { const r = lw.addLeads(parseCsv(fs.readFileSync(path.resolve(a[0]), 'utf8')), { source: 'csv', reason: `imported from ${path.basename(a[0])}` }); return out({ added: r.added.length, skipped: r.skipped }); }
    case 'export': return process.stdout.write(toCsv(lw.leads()));
    case 'outbox': return out(lw.outbox().filter(m => !a[0] || m.status === a[0]).map(m => `${m.id}  ${m.status.padEnd(16)} ${m.to}  "${m.subject}"${m.sendAfter ? '  after ' + m.sendAfter : ''}${m.status === 'blocked' ? '  ' + m.gate.errors.join('; ') : ''}`).join('\n') || '(empty)');
    case 'show': { const m = lw.outbox().find(x => x.id === a[0]); if (!m) throw new Error('unknown message'); return out(`To: ${m.to}\nSubject: ${m.subject}\nWhy: ${m.why}\nStatus: ${m.status}\nWarnings: ${m.gate.warnings.join('; ') || '-'}\n\n${m.body}`); }
    case 'approve': return out(lw.approve(a[0], { actor: 'human', note: a.slice(1).join(' ') }).status);
    case 'reject': return out(lw.reject(a[0], { actor: 'human', reason: a.slice(1).join(' ') || 'rejected' }).status);
    case 'send': return a[0] === '--watch' ? watchSend(a[1]) : out(lw.sendApproved({ actor: 'human' }));
    case 'verify': return out(await lw.verifyLeadDomains({ all: a[0] === '--all' }));
    case 'suppress': return out(lw.suppress(a[0], { reason: a.slice(1).join(' ') || 'manual', actor: 'human' }));
    case 'unsuppress': { const n = lw.suppression.remove(a[0]); lw.audit.record({ action: 'unsuppressed', actor: 'human', reason: `removed ${a[0]}` }); return out(`removed ${n}`); }
    case 'bounce': return out(lw.recordBounce({ email: a[0], code: a[1], diagnostic: a.slice(2).join(' '), actor: 'human' }));
    case 'why': return out(lw.why(a[0]) || 'unknown lead');
    case 'inbox': {
      if (a[0] === 'check') {
        const r = await lw.checkInbox({ actor: 'human' });
        for (const acct of r.accounts) console.error(`${acct.account}: ${acct.ok ? `${acct.fetched} fetched` : 'FAILED ' + acct.problems.join('; ')}`);
        if (r.accounts.some(x => !x.ok)) process.exitCode = 1;
        if (a.includes('--json')) return out(r);
        return out({ new: r.new.map(m => `${m.id}  ${m.category.padEnd(11)} ${m.from} -> ${m.to}${m.folder && m.folder !== 'INBOX' ? ' [' + m.folder + ']' : ''}  "${m.subject}"`), actions: r.actions });
      }
      if (a[0] === 'show') { const r = lw.inboxRecords().find(x => x.id === a[1]); if (!r) throw new Error('unknown inbox message'); return out(`From: ${r.fromName ? r.fromName + ' ' : ''}<${r.from}>\nTo: ${r.replyFrom || r.account}\nSubject: ${r.subject}\nDate: ${r.date}\nCategory: ${r.category} (${r.reasons.join('; ')})\nStatus: ${r.status}${r.replyId ? '  reply ' + r.replyId : ''}\n\n${r.text}`); }
      if (a[0] === 'close') return out(lw.markInbox(a[1], { status: 'closed', note: a.slice(2).join(' '), actor: 'human' }).status);
      if (a[0] === 'escalate') return out(lw.markInbox(a[1], { status: 'needs_human', note: a.slice(2).join(' '), actor: 'agent' }).status);
      // For an agent driving the CLI: the reply body comes from a file or stdin ("-") so quoting can't mangle it.
      if (a[0] === 'reply') {
        const [, id, intent, src] = a;
        if (!id || !intent || !src) throw new Error('usage: leonidas inbox reply <id> <intent> <body-file|->');
        const body = fs.readFileSync(src === '-' ? 0 : path.resolve(src), 'utf8');
        const r = lw.queueReply({ inboxId: id, body, intent, actor: 'agent' });
        return out({ id: r.message.id, status: r.message.status, autoSent: r.autoSent, from: r.message.from || r.message.replyFrom, result: r.result, waitingFor: r.waitingFor, why: r.why });
      }
      if (a[0] === 'test') {
        const { fetchRecent, accountProblems } = require('../src/imap');
        let bad = 0;
        for (const [i, acct] of (lw.cfg.inbox.accounts || []).entries()) {
          const label = acct.user || `inbox.accounts[${i}]`;
          const p = accountProblems(acct, `inbox.accounts[${i}]`);
          if (p.length) { bad++; console.log(`${label}: ${p.join('; ')}`); continue; }
          try { const r = await fetchRecent(acct, { listOnly: true }); console.log(`${label}: ok, checks ${r.folders.join(' + ')}`); } catch (e) { bad++; console.log(`${label}: FAILED ${e.message}`); }
        }
        if (bad) process.exitCode = 1;
        return;
      }
      const list = lw.inbox({ status: a[0] && a[0] !== '--json' ? a[0] : undefined });
      if (a.includes('--json')) return out(list);
      return out(list.map(m => `${m.id}  ${m.status.padEnd(15)} ${m.category.padEnd(11)} ${m.from} -> ${m.to}${m.folder && m.folder !== 'INBOX' ? ' [' + m.folder + ']' : ''}  "${m.subject}"`).join('\n') || '(empty)');
    }
    case 'audit': return out(a.includes('--verify') ? lw.audit.verify() : lw.audit.all());
    default: out(HELP); process.exitCode = 2;
  }
}

module.exports = { main, watchSend };
if (require.main === module) main(process.argv.slice(2)).catch(e => { console.error(`leonidas: ${e.message}`); process.exitCode = 1; });
