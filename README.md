# Joystyk libraries

Seventeen TypeScript libraries for deterministic games, browser sessions and Node services.
This repository contains the library source, tests and release harness. Host applications
and games are separate. Examples naming Joystyk host paths describe integration, not files
required to build this checkout.

Start with [the repository map](AGENTS.md), [architecture](ARCHITECTURE.md) and
[documentation index](docs/index.md). Each package has its own API README:

- [@joystyk/contracts](packages/contracts/README.md)
- [@joystyk/kit](packages/kit/README.md)
- [@joystyk/storage](packages/storage/README.md)
- [@joystyk/identity](packages/identity/README.md)
- [@joystyk/ops](packages/ops/README.md)
- [@joystyk/rooms](packages/rooms/README.md)
- [@joystyk/session](packages/session/README.md)
- [@joystyk/daily](packages/daily/README.md)
- [@joystyk/testing](packages/testing/README.md)
- [@joystyk/ui](packages/ui/README.md)
- [@joystyk/cards-ui](packages/cards-ui/README.md)
- [@joystyk/arcade](packages/arcade/README.md)
- [@joystyk/render3d](packages/render3d/README.md)
- [@joystyk/launcher](packages/launcher/README.md)
- [@joystyk/catalog](packages/catalog/README.md)
- [@joystyk/pwa](packages/pwa/README.md)
- [@joystyk/content](packages/content/README.md)

Use Node 24.15 and the pinned pnpm version. Run `pnpm install --frozen-lockfile`,
`pnpm exec playwright install chromium`, then `pnpm check`. The full gate verifies
source boundaries, documentation, types, unit/browser tests, builds and fresh npm consumers.

Original code in this checkout uses [MIT](LICENSE). Preserve [third-party notices](NOTICE).
Release preparation does not publish packages. See [the release runbook](docs/RELEASING.md).
