# Quality record

Status: initial source candidate. Verification must be recorded in Beads after the standalone
checkout passes its gates; this file does not imply publication or external publisher setup.

| Area | Enforced evidence | Limit |
| --- | --- | --- |
| Package graph | `pnpm check:arch` | Static imports and declared exceptions |
| Knowledge | `pnpm check:docs` | Links, indexes and IDs; prose still needs review |
| Source scope | `pnpm check:source` | Approved packages and required harness files |
| Models and adapters | Types, ESLint, unit and Chromium tests | No private host E2E suite here |
| Distribution | `pnpm check:release` | Exact tarballs, declarations and fresh consumers |
| Release authorization | Protected environment and trusted-publisher review | Requires actual external setup |

Keep acceptance evidence in the owning bead. Add a regression for a new failure mode and
promote recurring review feedback into a guard or owning document. Do not label an unverified
area complete merely because adjacent tests pass.
