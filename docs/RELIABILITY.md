# Reliability

Deterministic engines and simulations take seeded randomness explicitly. Sessions replay
intentions; authoritative rooms persist before broadcast, reject stale revisions and deduplicate
action IDs. Views and event redaction hide private state from unauthorized seats.

Boundary data is schema-parsed. Storage adapters own migrations and retention. Consumers own
their process supervision and durable volumes; this library repository runs no production
service. Browser suites use real Chromium and condition-based waits. Installed consumers test
Node, browser modules, Gyral SSR hydration, SQLite and service-worker builds independently.

Use [the quality gates](QUALITY_SCORE.md) and file discovered failures in [Beads](PLANS.md).
