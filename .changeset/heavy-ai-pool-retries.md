---
'@joystyk/rooms': minor
---

A heavy AI the job pool couldn't answer is asked again with backoff instead of playing the
timeout move. `ai-chosen` without a command now carries the pool's `failure`, `LiveRoom` gains
`aiRetry`, and `CoreLimits` gains `aiRetryMs`, `aiRetryMaxMs` and `aiAttempts`. The worker pool
runs each worker's jobs one at a time, counts a job's timeout from when it starts, and reports
`busy`, `lost` and `crashed` separately (`PoolOutcome`).
