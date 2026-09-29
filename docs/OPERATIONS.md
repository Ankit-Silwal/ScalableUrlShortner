# Deploying and operating the shortener

## Configuration

Use .env.example as the complete settings reference. Never commit .env.

| Setting | Default / purpose |
| --- | --- |
| NODE_ENV | development; production requires Redis |
| DATABASE_URL | Required PostgreSQL URI |
| BASE_URL | Required public HTTP(S) origin |
| API_KEY | Required secret, at least 32 characters |
| PORT / WORKER_PORT | 3000 / 9100 |
| REDIS_URL | Empty only for local synchronous development |
| REDIS_PREFIX | shortener; identical for APIs and workers sharing a database |
| DB_POOL_MAX | 10 per process |
| DB_QUERY_TIMEOUT_MS | 2000; pool acquisition and server statement timeouts |
| REDIS_TIMEOUT_MS | 500; command timeout |
| CACHE_TTL_SECONDS | 60; maximum 300 |
| ANALYTICS_STREAM_MAX_LENGTH | 100000 per partition |
| ANALYTICS_BATCH_SIZE | 500, maximum 5000 |
| ANALYTICS_POLL_MS | 200 when idle |
| MAX_INFLIGHT_REQUESTS | 500 per API process |
| API_RATE_LIMIT / REDIRECT_RATE_LIMIT | 60 / 300 per IP per window |
| RATE_LIMIT_WINDOW_MS | 60000 |
| TRUST_PROXY_HOPS | 0 locally; 1 behind the supplied Nginx |
| CORS_ORIGINS | Optional comma-separated browser origins |
| HTTP_LOG_ENABLED | false; metrics remain available |
| LOG_LEVEL | info |
| POSTGRES_PASSWORD / GATEWAY_PORT | Local scale Compose settings; generated URL-safe password / 8080 |

The sample Compose environment explicitly sets common operational values. To override other settings for containers, add them to its environment mapping; merely adding a variable to .env does not automatically pass it to a container.

## Connection budget

For three APIs and two workers at DB_POOL_MAX=10, budget up to 50 application connections, plus migrations, monitoring, and administration. Keep the total below PostgreSQL max_connections with reserve capacity. Increasing replicas without considering this budget can exhaust PostgreSQL. PgBouncer is a possible future addition; it is not included or configured here.

## Deployment

1. Set API_KEY, a generated hex POSTGRES_PASSWORD, and the public BASE_URL.
2. Build/release the image and run database migrations before accepting traffic.
3. Start API and worker replicas.
4. Verify /ready on each API and worker.
5. Expose the gateway through your HTTPS ingress. Keep database, Redis, and worker health/metrics ports private.
6. Configure metrics scraping and alerts before increasing traffic.

Local reproducible stack:

```powershell
docker compose -f compose.scale.yaml up -d --build --scale api=3 --scale worker=2
docker compose -f compose.scale.yaml ps
docker compose -f compose.scale.yaml logs --tail=100 api worker
```

Do not change POSTGRES_PASSWORD on an existing database volume and expect Compose to rotate it; database credentials must be changed in PostgreSQL as well.

Nginx replaces incoming X-Forwarded-For with its observed peer address. The one-hop proxy trust is valid for this topology. If another load balancer sits in front of Nginx, configure real client IP handling for trusted upstream CIDRs before using per-IP limits; otherwise clients can share an ingress IP.

The API is single-owner. For a public self-service product, add user authentication, per-owner authorization/quotas, abuse reporting, and destination moderation before exposing management endpoints.

## Alerts

Scrape every replica's /metrics with the x-api-key header, over a private network/TLS. Avoid code or destination labels.

Suggested starting alerts (tune against your SLO):
- Any increase in shortener_analytics_events_total with result dropped_full/dropped_error.
- Oldest analytics lag above 10 seconds for several minutes.
- p95 redirect latency above 100 ms or a rising 5xx rate.
- Sustained 429/503 responses.
- Redis memory above 70-80% of maxmemory; persistence/replication errors.
- Database connection saturation, query latency, locks, disk/WAL growth.
- Worker readiness failure or no worker metrics.

The API request histogram is shortener_http_duration_seconds; Redis cache outcomes use shortener_cache_total. Workers expose shortener_analytics_applied_total, shortener_analytics_batches_total, and shortener_analytics_lag_seconds.

## Failure behavior

| Failure | Behavior |
| --- | --- |
| One API process stops | Nginx retries eligible requests against remaining replicas |
| Worker stops | Redis retains pending clicks up to the configured cap; counts lag |
| Worker fails before commit | Counts and checkpoint roll back; retry is safe |
| Worker fails after commit, before trim | Checkpoint prevents double application |
| Queue reaches cap | New analytics dropped with metrics; redirect still works |
| Redis unavailable | Shared request limits return 503; APIs are unready after disconnect |
| Cached URL invalidation fails | Old redirect may survive until bounded cache expiry |
| PostgreSQL unavailable | Readiness fails; cold lookups/management fail; already-cached paths may still work while requests arrive |
| Redis loses recent data | Some analytics can be lost; recovery must preserve stream/checkpoint ordering |

GET retry after an uncertain response may count more than once because clicks are HTTP attempts. Do not use the count as a financial/billing ledger.

## Recovery

Ordinary worker restarts require no manual replay. Restart workers and let them read strictly after their committed partition checkpoints.

For a Redis restart with intact AOF/stream keys, verify persistence recovery, stream IDs, lag, and readiness before returning traffic. Redis stream IDs must remain greater than the checkpoint for new events to be processed. Stop writers/workers before any administrative stream repair.

If Redis data is lost/restored independently of PostgreSQL:
1. Stop APIs/workers and take backups of the surviving state.
2. Compare each analytics_checkpoints.last_id with the corresponding stream's last-generated-id.
3. Preserve any unprocessed events above the checkpoint. Never lower a PostgreSQL checkpoint to replay already-counted events.
4. If a stream was lost or has a lower last ID, repair its stream ID floor to at least the checkpoint using Redis administrative tooling before resuming writers (XSETID where the stream exists; recreate an empty stream with a retained marker when necessary).
5. Record the loss window, verify that new IDs advance beyond the checkpoint, then resume workers/APIs and monitor counts.

This is an operator recovery procedure, not automated failover. Test it against the managed Redis version/backup mechanism you use.

## Capacity validation

Use dedicated test services:

```powershell
docker compose -p shortener-tests -f compose.test.yaml up -d --wait
$env:TEST_DATABASE_URL = 'postgresql://shortener_test:test_password@127.0.0.1:54329/shortener_test'
$env:TEST_REDIS_URL = 'redis://127.0.0.1:6389'
npm run benchmark:million
```

Defaults: one million rows, two separate API processes, one worker, 32 concurrent requests, 15 seconds per traffic pattern, plus warmup. BENCH_LINKS, BENCH_DURATION_SECONDS, and BENCH_CONCURRENCY customize the run. Results go to benchmark-results/latest.json and latest.prom.

Repeat with the actual ingress, TLS, persistent Redis, hosted PostgreSQL, representative URLs, client distribution, expiration/deletion churn, failover events, and sustained bursts. Run an open-loop/arrival-rate test and a long soak before accepting a production capacity claim; the included load generator is closed-loop and can understate queueing under overload.

Stop only the disposable dependency stack when finished:

```powershell
docker compose -p shortener-tests -f compose.test.yaml down
```
