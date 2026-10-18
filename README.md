# Leonidas of the Web

*Formerly **leadwright**. The npm package is now `@kurtfrancisco/leonidas` and the command is `leonidas`; `leadwright` still works as a deprecated alias.*

**A compliance-first outbound sales pipeline that runs as an MCP server for Claude Code, Cursor and Codex.**

Your coding agent researches leads, scores them against an industry ICP, and drafts cold email. Leonidas checks every draft against CAN-SPAM and deliverability rules, logs *why* each lead was contacted, and holds everything for a human to approve. By default nothing is ever sent.

> Based on [Harvey](https://github.com/ethanplusai/harvey) by Ethan Rogers (MIT). Leonidas of the Web is an independent project. It is not affiliated with or endorsed by Ethan Rogers. The skills library and the content rules (banned phrases, merge-tag, link and plain-text checks) come from Harvey. The MCP server, compliance gate, send window, caps, audit log and ICP templates are new.

## Why
Autonomous SDR agents fail in the same ways: a fake "Re:" subject, a missing unsubscribe line, a burned domain, an email to someone who already opted out, and no record of why that person was emailed. Leonidas puts deterministic code between the model and the outbox.

## Features
- **MCP server (stdio, zero dependencies)** with 18 tools: `leo_add_leads`, `leo_writer_prompt`, `leo_check_email`, `leo_queue_email`, `leo_why`, `leo_send_approved`, `leo_objection`, `leo_dns_check`, and more. The 0.1.x `lw_*` names still work as aliases.
- **Never auto-sends.** `sending.mode` defaults to `"draft"`. Only a human approves (`leonidas approve <id>`). Agents can approve only if you set `approval.allowAgentApproval: true` yourself.
- **CAN-SPAM gate.** Every message gets a footer with your physical postal address and an opt-out line. `List-Unsubscribe` headers are added (one-click when you set a URL). Deceptive `Re:`/`Fwd:` subjects on a first touch are blocked.
- **Cold email bodies under 100 words** (footer excluded). Hard error at queue and send time. Config can tighten it but can't loosen it.
- **Subject lines under 30 characters.** This is a hard error. Config can tighten the limit but can't loosen it.
- **Tuesday/Wednesday sending only.** This is a hard rule: `sending.allowedDays` can narrow it to one of those days but can't add others. It must be Tue/Wed both in the lead's `timezone` (falling back to `sending.timezone`) and in America/Chicago. Approved mail that comes up on another day is marked `scheduled` for the next Tuesday or Wednesday and goes out on the next `leonidas send` run on or after that date.
- **Built-in SMTP** (zero dependencies) for cPanel and other hosted mailboxes: port 465 SSL or 587 STARTTLS, AUTH PLAIN/LOGIN, password from an environment variable only. A 550 on the recipient records a hard bounce and suppresses the address.
- **Verified-only sending** by default: leads must be marked `emailVerified: true` (or `verification: "valid"`).
- **Deliverability.** Daily cap, per-domain cap, a warmup ramp (5/day, +3/day, or an explicit `sending.ramp`), a send window, a minimum gap between sends, quiet hours, a bounce-rate circuit breaker (pauses above 5% hard bounces), and SPF/DMARC/DKIM checks.
- **Do-not-contact list.** Blocks exact emails (case and `+tag` normalized) and whole domains. Hard bounces and complaints are added automatically, and adding an entry pulls any pending mail to that address.
- **Audit log of decisions.** Each step records who acted and why, the evidence and the score reasons. The log is append-only JSONL with a SHA-256 hash chain, so tampering shows up. `leonidas why <email>` shows the full trail.
- **Eight industry ICP templates:** SaaS, agencies, home services, dental/clinics, e-commerce, real estate, professional services and manufacturing. Each lead is scored with readable reasons.
- **Content gate** from Harvey: banned spam and AI-tell phrases, unrendered merge tags, a one-link budget, plain text only, and a word ceiling. Also blocks role addresses and header injection.
- **CSV import and export.** Exports are protected against formula injection.

## Quick start
```bash
npx -y @kurtfrancisco/leonidas init --icp home_services
# edit .leonidas/config.json (or use YAML: .leonidas/config.yaml, see examples/): sender.name/company/email/physicalAddress, compliance.unsubscribe
npx -y @kurtfrancisco/leonidas install-snippets   # prints configs for all three hosts
```
**Claude Code:** `claude mcp add leonidas -- npx -y @kurtfrancisco/leonidas mcp`
**Cursor** (`.cursor/mcp.json`): `{"mcpServers":{"leonidas":{"command":"npx","args":["-y","@kurtfrancisco/leonidas","mcp"]}}}`
**Codex** (`~/.codex/config.toml`):
```toml
[mcp_servers.leonidas]
command = "npx"
args = ["-y", "@kurtfrancisco/leonidas", "mcp"]
```
Then ask your agent, for example: *"Find 20 HVAC companies in Austin, add them to Leonidas, and draft first-touch emails for the qualified ones."*

Review and send:
```bash
leonidas outbox pending_approval
leonidas show <id>
leonidas approve <id> "looks right"
leonidas send          # only works with sending.mode="send"; only Tue/Wed
leonidas why owner@example.com
```

## Configuration (`.leonidas/config.json` or `config.yaml`)
The config is found at `$LEONIDAS_CONFIG`, else `.leonidas/config.yaml`, `config.yml` or `config.json`. An existing `.leadwright/` folder and the `LEADWRIGHT_*` environment variables from 0.1.x keep working.

| Key | Default | Meaning |
|---|---|---|
| `sending.mode` | `"draft"` | Must be set to `"send"` explicitly before anything is delivered |
| `sending.allowedDays` | `["Tue","Wed"]` | Weekdays when cold email may go out |
| `sending.timezone` | `"America/Chicago"` | Used when a lead has no `timezone` |
| `sending.dailyCap` / `perDomainDailyCap` | 30 / 3 | Hard caps per day |
| `sending.warmup` | 5/day +3/day | Ramp for a new mailbox |
| `sending.maxBounceRate` | 0.05 | Hard-bounce rate that pauses sending (after 20 sends) |
| `sending.transport` | `"file"` | `file` writes `.eml` files to `.leonidas/sent/`. `command` pipes the message to e.g. `msmtp -t`. `smtp` uses the built-in client (below) |
| `sending.ramp` | `[]` | Explicit warmup caps per day, e.g. `[5, 10, 20]`, then `dailyCap`. Replaces the +3/day formula. Counted from `sending.warmup.startDate` |
| `sending.window` | none | `{start: "09:00", end: "13:00"}` in `sending.timezone`. Mail is held outside it |
| `sending.minIntervalSeconds` | 0 | Minimum gap between two sends |
| `sending.sendUnverified` | `false` | Hold mail to leads not marked verified |
| `sending.personalizeFirstEmail` | `true` | The writer brief requires a business-specific first line |
| `usage.quietHours` | none | `{start: "22:00", end: "07:00", timezone}`. No sending in this window (it may wrap midnight) |
| `usage.maxDailyBrainPercent` | 100 | Budget hint shown in status for the host agent. Not measured or enforced by Leonidas |
| `product.keyBenefits` | `[]` | List of benefits. The writer brief offers the 3 most relevant to each lead and asks for at most one |
| `product.objectionResponses` | `{}` | Map of objection to answer. `leo_objection` returns the closest match |
| `product.pricing`, `offer.primary`, `offer.entry` | `""` | Given to the writer as the only prices it may quote |
| `offer.bookingMethod` | `"reply"` | `reply`, `link` (needs `offer.bookingUrl`) or `ask_preference` (no link; ask email, text or a short call) |
| `offer.meetingDurationMinutes` | 15 | Number of minutes (`import-harvey` turns "10 minutes" into 10) |
| `approval.allowAgentApproval` | `false` | Lets the MCP agent approve its own drafts. Leave this off |
| `compliance.maxBodyWords` | 99 | Can only go lower. Bodies must be under 100 words, excluding the footer |
| `compliance.maxSubjectLength` | 29 | Can only go lower. Subjects must be under 30 characters |
| `icp.template` | `""` | One of the 8 templates (`leonidas templates`) |

### SMTP for cPanel mailboxes
In cPanel go to **Email Accounts > Connect Devices** and copy the "Secure SSL/TLS Settings" (outgoing server, usually `mail.yourdomain.com`).
```yaml
sending:
  mode: send            # only when you are ready
  transport: smtp
  smtp:
    host: mail.yourdomain.com
    port: 465           # 465 = SSL/TLS. Or 587 = STARTTLS (required; Leonidas refuses to log in unencrypted)
    user: you@yourdomain.com     # the full mailbox address
    passwordEnv: LEONIDAS_SMTP_PASSWORD
```
```bash
export LEONIDAS_SMTP_PASSWORD='mailbox password'   # never put it in the config file; config check rejects it
leonidas config check
```
`secure` defaults to true on 465 and false (STARTTLS) on 587. The certificate is verified. If your host's certificate only covers its server name (e.g. `server123.hostingcompany.com`), use that name as `host`. `caFile` points at a custom CA, and `rejectUnauthorized: false` turns verification off (not recommended). Also set SPF, DKIM and DMARC for the domain (`leonidas dns yourdomain.com default`). Every gate still runs before a connection is opened: approval, Tue/Wed, subject and word limits, footer, ramp and caps, window, quiet hours, verified-only and the bounce breaker. A 5xx on `RCPT` marks the message `failed`, records a hard bounce and suppresses the address. A 4xx leaves it approved for the next run.

### YAML configs, Harvey import and validation
```bash
leonidas import-harvey harvey.yaml .leonidas/config.yaml   # convert a Harvey-style config (persona/product/offer/icp/channels/usage/brain)
leonidas config check [file]                               # schema and safety check; exit code 1 on errors
```
`import-harvey` maps snake_case Harvey fields onto this schema and prints a note for each change. For example, `meeting_duration: 10 minutes` becomes `meetingDurationMinutes: 10`, `company_size: 1-20 employees` becomes `"1-20"`, and `provider: smtp` becomes `transport: smtp`. Duplicate YAML keys are reported (the last value wins). Imported configs always start in `draft` mode. `config check` warns about risky values: send days other than Tue/Wed, `sendUnverified: true`, approval turned off, plaintext SMTP. See [`examples/local-web-agency.yaml`](examples/local-web-agency.yaml) for a full example with placeholders.

## Pro ($11 launch price)
Leonidas Pro adds:
- Sequence and playbook packs for 8 industries
- A deeper compliance and deliverability checker: CASL/GDPR/PECR region rules, list hygiene, spam scoring, a full DNS audit and pack validation
- A one-command installer that registers the server with Claude Code, Cursor and Codex

Pro is sold separately. The core in this repo is MIT and fully usable without it. Existing leadwright Pro keys keep working.

**[Buy Leonidas Pro: $11 one-time →](https://buy.stripe.com/3cI8wR5LzbZw0lR0md5AQ04)**

## Legal
Leonidas helps you follow the rules, but it isn't legal advice. You're responsible for complying with CAN-SPAM, CASL, GDPR/PECR and your mail provider's terms.

## License
MIT. Copyright (c) 2026 Ethan Rogers (original Harvey) and Copyright (c) 2026 Kurt Francisco (modifications). See [LICENSE](LICENSE).
