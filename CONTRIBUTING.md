# Contributing to Leonidas of the Web (formerly leadwright)

Thanks for helping. Leonidas is a compliance-first outbound tool, so a few rules are non-negotiable:

1. **Safe defaults stay safe.** `sending.mode` defaults to `"draft"`, `approval.allowAgentApproval` to `false`, `allowedDays` to `["Tue","Wed"]`. A PR that loosens any default will be closed.
2. **The gate is deterministic.** No model calls in `src/compliance.js` or `src/deliverability.js`.
3. **Subjects must stay under 30 characters.** Templates, examples and prompts included. Tests enforce it.
4. **Every contact decision needs a "why".** New send paths must write to the audit log.
5. **Zero runtime dependencies.** Node 18+ standard library only.

## Dev
```bash
npm test            # node --test, no installs needed
node bin/leonidas.js --help
```
Add a test with every change. Keep the MIT notice (Ethan Rogers + Kurt Francisco) intact.

## Reporting a problem
Open an issue with steps to reproduce. For security problems (e.g. a way to bypass approval or the send window), email Fpavia111@gmail.com instead of filing a public issue.
