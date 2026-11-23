# Changelog

## Unreleased
### Added
- Follow-up sequences: `sequence.followups` ([{afterDays, body}]) and `leonidas followups`. Each step goes to cold mail nobody answered once the previous email is `afterDays` old, threaded under it ("Re:", In-Reply-To/References) from the same mailbox, with `{first}`, `{name}` and `{company}` filled in. Leads who replied, bounced or opted out get nothing more.
- Reading replies over IMAP (`inbox.accounts`, `leonidas inbox check`, MCP `leo_check_inbox`). Read-only: mail is opened with EXAMINE and fetched with BODY.PEEK. Each account's inbox and spam/junk folders are checked (`checkSpam`, or an explicit `folders` list). Each message is sorted with Harvey's opt-out and escalation rules plus phishing, bounce, auto-reply and newsletter checks. Opt-outs are suppressed, bounces recorded, and a replying lead's pending cold mail is pulled.
- Answering replies: `leo_queue_reply` / `leonidas inbox reply` (threaded with In-Reply-To/References, sent from the mailbox the person wrote to) and `leo_mark_inbox` / `inbox close|escalate`. With `inbox.autoReply: true`, safe replies to people are sent without review, limited by `inbox.autoReplyTo`, `inbox.maxAutoRepliesPerDay` and a two-per-person-per-day loop guard. `leonidas inbox test` checks every login.
- Replies are not held to the Tue/Wed rule or the send window, which are for cold email.
- Several sending mailboxes: `sending.mailboxes` (each with its own password env var, daily cap and warmup start), `sending.totalDailyCap` and `sending.hourlyCap` (all mailboxes together). Mail goes from the least-used mailbox with room. A recipient always hears from the same mailbox. `leonidas status` shows each mailbox.
- Each send and bounce records the mailbox it came from.
- `leonidas mailboxes test` logs in to every sending mailbox and logs out, without sending anything.
- `leonidas send --watch [seconds]` keeps running and sends as the limits allow. It prints only deliveries, failures and changes in what it is waiting for.
- `import-harvey` carries over `channels.email.mailboxes` (the main mailbox first) and `max_hourly_sends`.
- `leonidas import-harvey-contacts <csv>` imports a Harvey contacts export. Opt-outs and invalid addresses go to do-not-contact, and prospects Harvey already wrote to are left out.
- The YAML reader accepts flow collections such as `[50, 100]` and `{address: a@b.c, port: 465}`.

### Fixed
- With `approval.required: false`, a message that passes every gate is approved as it is queued, so unattended sending actually sends. Before, it sat in `pending_approval` forever. Gate failures are never auto-approved.
- ICP targeting can be enforced: `icp.requireGeography` disqualifies leads outside `icp.geography` (one-way match, so "Texas" isn't "San Antonio"), `icp.blockUnqualified` blocks cold mail to unqualified leads, and a disqualified lead's cold mail is always blocked. Leads are re-scored at queue time, so a tightened ICP covers leads added earlier. `icp.signals` and `icp.geography` can replace the template's, and `icp.disqualifiers` add to them (matched against industry, company and notes).
- The writer prompt tells the model to greet by first name, say why it is writing to this business, and make one concrete offer.
- `addLeads` (and every import) skips addresses a scraper picks up that are never a person: image and asset file names (`x@72x-copy.avif`), template placeholders (`john.doe@`, `nombre@correo.com`, `example@`), platform domains and malformed addresses. These made up part of 204 bounces in a real campaign.
- `leonidas verify [--all]` checks that each lead's domain can receive mail (MX, or A/AAAA as the implicit MX). A domain with no mail server goes on the do-not-contact list and its pending mail is pulled. Dead domains caused about two thirds of the bounces in the same campaign.
- `leonidas dns <domain>` reports the domain's registration date (RDAP via IANA's bootstrap) and flags a domain under 30 days old, which recipients' filters treat as a spam signal.
- The content gate warns about a nameless cold-email greeting ("Hi there", "Dear Team").
- Outgoing mail now has `Date`, `Message-ID` (on the sending mailbox's domain), `MIME-Version` and `Content-Transfer-Encoding` headers. Spam filters score mail without a Date header as spam. A non-ASCII subject or display name is sent as an RFC 2047 encoded word.

### Changed
- `sending.allowedDays` can list any weekdays. Tue/Wed stays the default, and `config check` warns about other days and rejects names that aren't weekdays. Before, other days were silently ignored.
- A send run stops checking messages one by one once a limit holds them all: the daily or hourly cap, the send window, quiet hours, `minIntervalSeconds` or the bounce pause. Only the first is written to the audit log, so a send loop doesn't fill the log.
- A failed SMTP login, a connection problem or a host sending-limit reply (including cPanel's "exceeded the max emails per hour") no longer marks the message `failed` or records a bounce. The message moves to the next mailbox. The failing mailbox rests for an hour (login, limit) or 10 minutes (connection), across runs. Recipient replies such as a full mailbox or an unknown user still count as bounces.
- Only one send runs at a time per state folder; a concurrent `send` or `leo_send_approved` reports `busy`. A message rejected or suppressed during a run is no longer sent.
- Each message is checked against the current time, so the window, quiet hours and hourly cap hold during a long run.
- A message that stays held for the same reason is written to the audit log once, not on every run.

## 0.2.0 (unreleased)
### Renamed: leadwright is now Leonidas of the Web
- npm package `@kurtfrancisco/leonidas`, CLI `leonidas`, MCP server name `leonidas`, tools `leo_*`.
- Still works: the `leadwright` command (prints a deprecation notice), the `lw_*` tool names, the `.leadwright/` state folder, and the `LEADWRIGHT_*` environment variables.
- Pro license keys are unchanged (product id `leadwright-pro`). Harvey / Ethan Rogers credit kept.

### Added
- Built-in SMTP delivery (`sending.transport: smtp`) with no new dependencies, for cPanel mailboxes: 465 SSL or 587 STARTTLS, AUTH PLAIN/LOGIN, certificate verification, password from an env var only. A 5xx on the recipient means a hard bounce and suppression; a 4xx is retried on the next run.
- YAML configs (`.leonidas/config.yaml` or `$LEONIDAS_CONFIG`). `leonidas config check` validates a config. `leonidas import-harvey` converts Harvey-style configs.
- New settings: `sending.ramp` (e.g. 5/10/20), send window, minimum interval between sends, quiet hours, `sendUnverified` (default off), `personalizeFirstEmail`, `product.keyBenefits`, `product.objectionResponses` with the new `leo_objection` tool, `offer.entry`, `offer.bookingMethod` (`reply` / `link` / `ask_preference`) and `offer.meetingDurationMinutes`.
- `examples/local-web-agency.yaml` with placeholder business details.

### Changed (stricter)
- Cold email only goes out on Tue/Wed, and it must be Tue/Wed in America/Chicago as well as in the lead's timezone. Config can narrow the days but not add others.
- Mail to unverified leads is held unless `sending.sendUnverified: true`.

## 0.1.1
- README: link to buy Pro ($11).

## 0.1.0
- First release as leadwright: compliance-first outbound MCP server, based on Harvey by Ethan Rogers (MIT).
