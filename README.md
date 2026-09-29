# Scalable URL Shortener

A Node.js / Express / PostgreSQL URL shortener designed for millions of stored links and millions of redirects per day. Redis provides shared caching, rate limits, and a bounded click stream; independent workers batch analytics into PostgreSQL.

**Measured locally with 1,000,000 stored links:** 2,798-3,935 redirects/second across three traffic patterns, zero request errors, and 154,952/154,952 clicks applied. This is a short local benchmark, not a production SLA. See [the benchmark report](docs/benchmarks/2026-09-29.md) for hardware, methodology, raw results, and limitations.

## Start locally

Requirements: Node.js 22.13+ (24 recommended), PostgreSQL, and Redis for the scalable mode.

```powershell
npm ci
Copy-Item .env.example .env
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

If you already have `.env`, edit it without overwriting it. Set:

- `DATABASE_URL`: PostgreSQL connection URI.
- `API_KEY`: generated random secret, at least 32 characters.
- `BASE_URL`: origin for your short URLs, e.g. `http://localhost:3000`.
- `REDIS_URL`: e.g. `redis://127.0.0.1:6379`.

Optional local dependencies (the database defaults match `.env.example`):

```powershell
docker compose up -d postgres redis
npm run db:migrate
npm run dev
```

In a second terminal:

```powershell
npm run worker
```

Without `REDIS_URL`, development uses synchronous PostgreSQL click updates and per-process rate limits. Production requires Redis. With Redis configured, run the worker for click statistics to advance.

## Run multiple instances

Set `API_KEY`, a URL-safe `POSTGRES_PASSWORD` (generated hex works), and `BASE_URL=http://localhost:8080` in `.env`:

```powershell
docker compose -f compose.scale.yaml up -d --build --scale api=3 --scale worker=2
```

This runs Nginx, three independent API processes, two analytics workers, PostgreSQL, and persistent Redis. Migrations finish before app startup. Only Nginx is published, on loopback port 8080. Put an HTTPS ingress in front of it for public deployment. This single-machine Compose stack demonstrates horizontal application scaling; managed database/Redis failover and multiple hosts are separate production infrastructure.

## Architecture

```mermaid
flowchart LR
  Client --> Gateway[Nginx / HTTPS ingress]
  Gateway --> APIs[Stateless Node API replicas]
  APIs --> Limits[Redis shared rate limits]
  APIs --> Cache[Redis URL cache]
  Cache -. cache miss .-> DB[(PostgreSQL)]
  APIs --> Queue[Redis click streams]
  Queue --> Workers[Analytics workers]
  Workers --> DB
```

```text
src/
  app.js                       Express dependency composition
  server.js                    API startup and graceful shutdown
  worker.js                    Worker startup, health, metrics, shutdown
  config/                      Environment, PostgreSQL, Redis, migrations
  routes/                      Route registration
  controllers/                 HTTP request/response handling
  services/                    Business rules and cache lookup flow
  repositories/                Parameterized PostgreSQL queries
  models/                      Database/domain mapping
  validators/                  Request schemas
  middleware/                  Auth, validation, shared limits, overload, errors
  infrastructure/              Redis cache, click streams, Prometheus metrics
  workers/                     Batched analytics and durable checkpoints
  utils/                       Application errors and pagination cursors
migrations/                    Versioned transactional SQL
deploy/                        Nginx configuration
scripts/                       Migration, load, benchmark, and smoke-test tools
tests/                         Unit/HTTP and real PostgreSQL/Redis integration tests
docs/                          Scaling design, operations, and measured benchmarks
.github/workflows/             Automated tests and container checks
```

See [how scaling works](docs/SCALING.md) and [deployment/operations](docs/OPERATIONS.md).

## API

All management endpoints require `x-api-key`. This is a single-owner/backend service: the key can manage every link. Keep it on your backend rather than embedding it in a public frontend.

| Method | Path | Behavior |
| --- | --- | --- |
| POST | /api/v1/links | Create link |
| GET | /api/v1/links?limit=20&cursor=... | List newest links using a cursor |
| GET | /api/v1/links/:code | Link details and eventually consistent click counts |
| DELETE | /api/v1/links/:code | Soft-delete link; returns 204 |
| GET | /:code | Public 302 redirect and enqueue a click |
| HEAD | /:code | Redirect headers without a click |
| GET | /health | Process liveness |
| GET | /ready | Dependency readiness |
| GET | /metrics | Prometheus metrics; API key required |

Create a link:

```powershell
$headers = @{ 'x-api-key' = 'YOUR_API_KEY' }
$body = @{
  originalUrl = 'https://example.com/a/long/path?campaign=launch'
  customAlias = 'launch'
  # Optional: expiresAt = '2030-12-31T23:59:59Z'
} | ConvertTo-Json
$link = Invoke-RestMethod -Method Post -Uri 'http://localhost:3000/api/v1/links' -Headers $headers -ContentType 'application/json' -Body $body
$link.data.shortUrl
```

Only `originalUrl` is required. It must be HTTP(S), contain no embedded credentials, and be at most 2048 characters. Aliases are case-sensitive, 4-32 letters, digits, underscores, or hyphens; system paths are reserved. Generated codes use 72 random bits with database collision retries. Expiry must be a future ISO 8601 timestamp with timezone.

Listing returns `{ success, data, pagination: { limit, nextCursor } }`. Pass `nextCursor` unchanged for the next page; null means the end. Cursors preserve PostgreSQL microsecond precision. `page=1` remains accepted; use cursors instead of higher page numbers.

Expired links return 410. Missing/deleted links return 404. Deleted aliases remain permanently reserved, preventing old URLs or delayed analytics from being assigned to a new destination. Statistics count GET requests including bots, not unique people. Responses use `Cache-Control: no-store`.

Errors use:

```json
{
  "success": false,
  "error": { "code": "LINK_NOT_FOUND", "message": "Short link not found" },
  "requestId": "request-uuid"
}
```

Other statuses: 400 invalid input, 401 invalid API key, 409 reserved alias, 413 oversized body, 429 shared rate limit, 503 overload or unavailable request protection.

## Verification

```powershell
npm test
docker compose -p shortener-tests -f compose.test.yaml up -d --wait
$env:TEST_DATABASE_URL = 'postgresql://shortener_test:test_password@127.0.0.1:54329/shortener_test'
$env:TEST_REDIS_URL = 'redis://127.0.0.1:6389'
npm run test:integration
docker build -t shortener-local:latest .
npm run test:compose
npm run benchmark:million
```

Integration tests create/drop only their randomly named PostgreSQL schemas and Redis namespaces. The Compose smoke test starts its own project on port 18080 and removes that project's containers and volumes afterward. The benchmark seeds an isolated million-row schema, launches two API processes plus a worker, verifies final click totals, saves reports to ignored `benchmark-results/`, and cleans up.

`npm run test:postgres:local` is also available if PostgreSQL command-line binaries are installed; `PG_BIN` can point to their directory. It tests PostgreSQL using a temporary cluster without touching your app database.

For an existing test deployment:

```powershell
$env:LOAD_URL = 'http://localhost:8080/your-test-link'
$env:LOAD_CONCURRENCY = '32'
$env:LOAD_DURATION_SECONDS = '30'
npm run load:test
```

The generator follows no redirects and expects 302. It fails on transport errors or unexpected statuses, including 429. Adjust limits only in your dedicated benchmark environment.

GitHub Actions runs unit/HTTP tests, real PostgreSQL/Redis integration tests, dependency auditing, an image build, and the multi-replica Compose smoke test on pushes to main.
