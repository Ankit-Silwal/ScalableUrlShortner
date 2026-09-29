# How this scales

## Define the target

A million stored links and a million redirects per day are different capacity dimensions:

| Redirects/day | Average requests/second | Example 10x burst |
| --- | ---: | ---: |
| 1 million | 11.6 | 116 |
| 10 million | 115.7 | 1,157 |
| 50 million | 578.7 | 5,787 |

The architecture targets millions of links and daily redirects. It does not claim one million requests per second. Size and test for the real traffic distribution, peak bursts, latency target, and failure budget. [Measured local results](benchmarks/2026-09-29.md) provide evidence, not a 24-hour capacity guarantee.

## 1. Stateless API replicas

Nginx distributes traffic to independent Node.js processes. API instances share PostgreSQL and Redis; no session, authoritative link data, or rate-limit counter lives in one API process. Add replicas with `--scale api=N`. Cache-miss coalescing is a short-lived per-process optimization, not authoritative storage.

Each process has a maximum in-flight request count and bounded database pool. Excess in-flight work gets 503 instead of growing memory without limit. Queries and Redis commands have timeouts; Redis has no offline command buffer or automatic resending of ambiguous operations.

## 2. Fast redirect lookups

The previous implementation updated a PostgreSQL row for every redirect, serializing writes on popular links. The scalable path is:

1. Apply a shared per-IP limit in Redis using an atomic increment/expiry script.
2. Read the URL mapping from Redis.
3. On a miss, read the indexed PostgreSQL row, then cache it with a bounded TTL.
4. Check expiry on every request, even when the cached mapping exists.
5. Enqueue a small click event to Redis and return 302.

A warm redirect makes no PostgreSQL query. Concurrent misses for the same code coalesce within each replica. Unknown links receive short negative-cache entries. Creation replaces negative entries; deletion installs a tombstone and ordinary cache fills use SET NX so they cannot overwrite it.

PostgreSQL remains authoritative. Cache errors fall back to the database at the lookup layer, but a total Redis outage makes shared request protection return 503, keeping the database from receiving an uncontrolled traffic surge. Positive cache TTL defaults to 60 seconds.

Invalidation is not a distributed transaction with PostgreSQL. If deletion commits but the Redis invalidation fails, a cached destination may remain available until its TTL expires. In-flight reads can overlap deletion. These are bounded-staleness semantics, not linearizable deletion. Aliases are never reused; expiry is always checked locally.

## 3. Batched analytics with transactional progress

A fixed hash of the code selects one of 16 Redis streams. All clicks for a popular code go to the same partition. API processes await the bounded Redis enqueue operation, but do not wait for a PostgreSQL update.

Workers:
1. Lock the partition's checkpoint row using FOR UPDATE SKIP LOCKED.
2. Read up to 500 events strictly after that checkpoint.
3. Group events by code and update each affected link once.
4. Save the last processed stream ID in the same PostgreSQL transaction.
5. After COMMIT, trim only stream IDs below that checkpoint.

A rollback commits neither counts nor progress. A worker crash after commit but before trimming leaves events in Redis, but the next worker reads after the saved checkpoint. Multiple workers coordinate through PostgreSQL; one worker owns a partition transaction at a time. There is no unbounded per-click deduplication table.

This provides replay-safe database application for events retained in the stream under the supported single-primary Redis topology. It is not an end-to-end exactly-once delivery guarantee: requests can fail after enqueuing, Redis can lose unpersisted data, and analytics is best effort at enqueue time.

Stats are eventually consistent, usually within a polling interval plus processing time when the worker keeps up. HEAD requests do not create events. GETs count requests rather than unique visitors.

## 4. Bounded queues and explicit failure choices

Each stream has an atomic maximum length (default 100,000, total at most 1.6 million across 16 partitions). Full queues reject new analytics events instead of discarding existing unprocessed events. Redirects still complete and increment `dropped_full` or `dropped_error` metrics.

Do not use an eviction policy that can remove stream keys. The sample uses noeviction and AOF every second. A Redis crash can lose roughly the most recent second of writes; replication/failover can widen this window. Use managed persistence/replication appropriate to the desired durability, and back up PostgreSQL and Redis consistently.

If a worker is stopped, streams grow until their per-partition cap. Hot-code skew matters: one viral link can fill its partition before other partitions. Memory exhaustion can also cause rate-limit operations to fail closed with 503. Monitor and size both queue capacity and Redis memory.

Redis Cluster/Sentinel discovery is not implemented in the application. The client expects one primary endpoint (a managed service may provide failover behind that endpoint). The fixed stream-partition count must not change without draining/migrating checkpoints. After loss/restoration of a stream, stream IDs must remain above its saved PostgreSQL checkpoint; never reset checkpoints blindly. See the recovery runbook.

## 5. PostgreSQL access patterns

- A primary key makes code lookup indexed and enforces concurrent alias uniqueness.
- A partial composite index on active (created_at DESC, code DESC) supports cursor pagination.
- Cursors preserve microseconds, avoiding skipped rows from JavaScript millisecond rounding.
- All values are parameterized; cursor data never becomes SQL syntax.
- Soft-deleted aliases remain reserved.
- Connection pools are bounded per process; aggregate budgets matter more than one setting.

Cursor pagination scans a small page after an indexed boundary instead of scanning and discarding hundreds of thousands of rows with OFFSET. Concurrent new links appear ahead of an existing cursor and do not cause duplicate results.

Migrations 002/003 add the index/tombstones and checkpoints to the initial schema. They run transactionally. For an already busy large production database, plan a maintenance/index rollout: this runner does not support CREATE INDEX CONCURRENTLY inside its transaction.

## 6. Observability and operational limits

Authenticated Prometheus endpoints expose request latency/status, process metrics, cache outcomes, analytics enqueue outcomes, worker batches/events, and oldest-unprocessed-event age per partition. Labels use route templates, never short codes or destination URLs. Worker metrics are on port 9100; API metrics are on port 3000. Scrape each replica independently rather than repeatedly scraping one load-balanced address.

Health probes are separate from business request limits. Readiness checks PostgreSQL/Redis status for APIs and recent successful polling for workers. Per-request logging is off by default to avoid logging every redirect; logs omit API keys, bodies, destination URLs, and query strings.

The Compose file is a deployable single-host example, not a multi-region HA platform. Production still needs HTTPS, a managed or operated PostgreSQL primary with failover/backups, Redis persistence/failover, monitoring, and tested recovery. Add replicas based on measured CPU/latency, workers based on lag, and database capacity based on cold-read and batch-write throughput.

## Why these mechanisms

Official references: [Redis streams](https://redis.io/docs/latest/develop/data-types/streams/), [safe stream trimming by ID](https://redis.io/docs/latest/commands/xtrim/), [ioredis connection/retry options](https://redis.github.io/ioredis/interfaces/CommonRedisOptions.html), [PostgreSQL row locking](https://www.postgresql.org/docs/current/sql-select.html), and [node-postgres transactions](https://node-postgres.com/features/transactions).
