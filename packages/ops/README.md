# @joystyk/ops

Node operations helpers: Prometheus counters and gauges, database backup rotation, and validated runtime configuration. Run metrics on a private listener and use fixed label vocabularies.

`rateLimitKey(address)` gives Node services one canonical network limit key: an IPv4 address,
or the first 64 bits of an IPv6 address. IPv4-mapped IPv6 forms share the IPv4 key. Apply it
after validating the socket peer and trusted forwarding headers; it does not establish proxy
trust. Keep the key in memory or hash it before storage, and never log it.

## npm package

The first `0.1.0` release is being prepared; it has not been published. Once available:

```sh
npm install @joystyk/ops
```

Requires Node 24.15 or later. This package runs on the server.

| Import | Format |
| --- | --- |
| `@joystyk/ops` | ES module and TypeScript declarations |

Only the entries listed above are public API. Installed packages contain compiled ESM,
type declarations and runtime assets. Repository-relative links describe the Joystyk
workspace and are not needed to use the npm package.

```ts
import { createMetrics } from '@joystyk/ops';

const metrics = createMetrics();
const requests = metrics.counter('requests_total', 'Requests served');
requests.inc({ status: 'ok' });
console.log(metrics.render());
```
