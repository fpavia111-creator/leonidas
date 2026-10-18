# Changelog

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
