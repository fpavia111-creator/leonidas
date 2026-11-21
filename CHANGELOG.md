# Changelog

## Unreleased
### Added
- Several sending mailboxes: `sending.mailboxes` (each with its own password env var, daily cap and warmup start), `sending.totalDailyCap` and `sending.hourlyCap` (all mailboxes together). Mail goes from the least-used mailbox with room. A recipient always hears from the same mailbox. `leonidas status` shows each mailbox.
- Each send and bounce records the mailbox it came from.
- `leonidas mailboxes test` logs in to every sending mailbox and logs out, without sending anything.
- `leonidas send --watch [seconds]` keeps running and sends as the limits allow. It prints only deliveries, failures and changes in what it is waiting for.
- `import-harvey` carries over `channels.email.mailboxes` (the main mailbox first) and `max_hourly_sends`.
- `leonidas import-harvey-contacts <csv>` imports a Harvey contacts export. Opt-outs and invalid addresses go to do-not-contact, and prospects Harvey already wrote to are left out.
- The YAML reader accepts flow collections such as `[50, 100]` and `{address: a@b.c, port: 465}`.

### Changed
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
