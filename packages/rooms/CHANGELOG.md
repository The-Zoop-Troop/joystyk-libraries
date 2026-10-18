# @joystyk/rooms

## 0.2.0

### Minor Changes

- bb095c7: A heavy AI the job pool couldn't answer is asked again with backoff instead of playing the
  timeout move. `ai-chosen` without a command now carries the pool's `failure`, `LiveRoom` gains
  `aiRetry`, and `CoreLimits` gains `aiRetryMs`, `aiRetryMaxMs` and `aiAttempts`. The worker pool
  runs each worker's jobs one at a time, counts a job's timeout from when it starts, and reports
  `busy`, `lost` and `crashed` separately (`PoolOutcome`).

### Patch Changes

- bb095c7: Share canonical IPv4 and IPv6 /64 rate-limit keys across Node services. Keep room
  initialization diagnostics on the server behind a client-safe reference, and expire old
  message-rate strikes. Extend hidden-information conformance checks with transition-aware
  perturbations so private events remain testable when recipients gain cards.
- Updated dependencies [bb095c7]
- Updated dependencies [bb095c7]
- Updated dependencies [bb095c7]
  - @joystyk/contracts@0.2.0
  - @joystyk/ops@0.2.0
  - @joystyk/identity@0.2.0
  - @joystyk/kit@0.2.0

## 0.1.0

### Minor Changes

- Prepare the first compiled library release: ESM and API declarations for every public entry point, runtime assets, and checks against installed npm tarballs. Games and applications remain private.

### Patch Changes

- Updated dependencies
  - @joystyk/contracts@0.1.0
  - @joystyk/kit@0.1.0
  - @joystyk/identity@0.1.0
