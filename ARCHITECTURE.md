# Library architecture

The packages form a dependency graph, not a shared source tree. Contracts are portable and
dependency-free; kit supplies seeded deterministic utilities. Session and room protocol code
coordinate intentions and authoritative state. Browser adapters own DOM/storage; Node adapters
own filesystem, SQLite and network effects. Testing is a development dependency.

UI packages use Gyral. Heavy rendering dependencies are isolated in render3d. Every package
owns its exports, README and adjacent tests. The dependency table is generated from
`scripts/architecture.json`; run `node scripts/check-architecture.ts --write-docs` after edits.

<!-- architecture-table:start -->
| Code | May import | Notes |
| --- | --- | --- |
| `contracts` | Nothing | Pure: the engine purity rules apply. |
| `kit` | `contracts` | Pure: the engine purity rules apply. |
| `testing` | `contracts`, `kit`, `session`, `rooms` |  |
| `session` | `contracts`, `kit`, `rooms` (`./protocol` only) |  |
| `rooms` | `contracts`, `kit`, `identity` (`./names` only), `ops` |  |
| `storage` | `contracts` |  |
| `identity` | `contracts`, `storage` |  |
| `daily` | `contracts`, `kit`, `storage` |  |
| `ops` | Nothing |  |
| `content` | `contracts`, `kit`, `daily` |  |
| `ui` | Nothing |  |
| `cards-ui` | `contracts`, `kit`, `ui` (`./tokens.css` only) |  |
| `arcade` | `contracts`, `kit`, `session` |  |
| `render3d` | `contracts` | Heavy libraries allowed. |
| `launcher` | `contracts`, `kit`, `session`, `storage`, `identity`, `ui`, `daily` |  |
| `catalog` | `contracts`, `launcher`, `ui` |  |
| `pwa` | `contracts`, `storage` (`./browser` only), `daily` (`./browser` only) |  |
| `apps/*` |  |  |
<!-- architecture-table:end -->

See [core beliefs](docs/design-docs/core-beliefs.md), [quality](docs/QUALITY_SCORE.md)
and [release boundaries](docs/RELEASING.md).
