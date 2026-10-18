# Joystyk libraries: repository map

This project follows [harness engineering](docs/references/harness-engineering.md).
Humans choose outcomes; agents implement, inspect evidence and improve the environment.
Keep this file a short map. Detailed knowledge belongs in indexed repository documents.

## Start here

1. Run `bd prime`, then `bd ready`. Beads is the only work tracker.
2. Read [docs/index.md](docs/index.md), then [ARCHITECTURE.md](ARCHITECTURE.md).
3. Read [core beliefs](docs/design-docs/core-beliefs.md) and [decisions](docs/design-docs/decisions.md).
4. Read the affected package's README and adjacent tests before changing its API.

## Where things live

| Need | Location |
| --- | --- |
| APIs and examples | `packages/<name>/README.md` |
| Contracts, implementation and tests | `packages/<name>/src/` |
| Dependency boundaries | [architecture](ARCHITECTURE.md), `scripts/architecture.json` |
| Build and release validation | `scripts/build-package.ts`, `scripts/release/` |
| Durable plans and dependencies | [Beads workflow](docs/PLANS.md) |
| Evidence and limitations | [quality record](docs/QUALITY_SCORE.md) |
| Reliability and security | [reliability](docs/RELIABILITY.md), [security](docs/SECURITY.md) |
| Release approvals and publisher setup | [release runbook](docs/RELEASING.md) |

## Commands

Use Node from `.nvmrc` and pnpm from `package.json`.

| Command | Purpose |
| --- | --- |
| `pnpm check` | Every source, test, build and installed-consumer gate; run before committing |
| `pnpm check:source` | Approved scope and harness boundaries |
| `pnpm check:arch` | Package edges, public exports, purity and heavy dependencies |
| `pnpm check:docs` | Links, indexes, decision IDs and this map's length |
| `pnpm typecheck` / `pnpm lint` | Strict types and Gyral template rules |
| `pnpm test:unit` | Node tests, including DOM-free models |
| `pnpm test:browser` | Real Chromium component tests |
| `pnpm format:check` / `pnpm format` | Check or apply the pinned formatter |
| `pnpm check:release` | Strict tarball metadata and isolated installed consumers |

## Essential invariants

- Keep contracts and deterministic utilities free of host IO, clocks and ambient randomness.
- Parse network, storage and configuration boundaries through Standard Schema.
- Import another package by its public name; never reach through its source directory.
- Views, reducers and initial state are pure; Gyral commands perform effects.
- Browser behavior is tested in Chromium. Wait for conditions, not fixed wall-clock delays.
- Public API changes include documentation, relevant tests and a Changeset.
- Keep original-code MIT terms separate from third-party data and code notices.
- No private host applications, game source, secrets or tracker history enter this repository.

## Working rules

- Create or claim the bead before work; link discoveries with `discovered-from`.
- Record evidence and blockers in Beads. Do not create competing markdown task lists.
- Review the diff against acceptance criteria. Fix missing tools or docs when they impede work.
- When implementation or a boundary changes, update the owning documentation and its checks.
- Before reporting done, run the relevant gates and stop processes started for the task.
- Commit, push, create releases or publish only with user authorization.
- Keep commits free of co-author or tool-attribution lines.
- This checkout uses fresh Beads prefix `jlib`. Never import a private project's database.
- After remote creation is approved, sync through `bd dolt push`; until then, keep work local.
