# URL Shortener

Node.js (JavaScript), Express 5, and PostgreSQL. Includes authenticated link management, public redirects, custom aliases, expiry dates, click counts, request validation, rate limiting, structured logging, and SQL migrations.

## Requirements and setup

- Node.js 22.13+ (Node 24 recommended)
- PostgreSQL, locally or hosted

Dependencies are pinned in `package-lock.json`.

```powershell
npm ci
Copy-Item .env.example .env
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Set `API_KEY` to the generated secret, `DATABASE_URL` to your PostgreSQL connection string, and `BASE_URL` to your public origin. The app validates configuration and refuses to start with missing required settings. Keep `.env` private; it is ignored by Git.

For the optional local Docker database:

```powershell
docker compose up -d postgres
```

The development connection string in `.env.example` matches Docker Compose. If PostgreSQL is already on port 5432, use that instance or change the Compose port and your connection string. Create the database first when using an existing PostgreSQL server.

Apply migrations, then start:

```powershell
npm run db:migrate
npm run dev
# Or: npm start
```

Migrations are explicit, transactional, tracked in `schema_migrations`, and protected by a PostgreSQL advisory lock. Startup checks that the database and links table are available.

## Architecture

```text
src/
  app.js                         Express composition; independently testable
  server.js                      Startup, HTTP server, graceful shutdown
  config/
    env.js                       Validated environment settings
    database.js                  PostgreSQL pool and readiness check
    migrations.js                Transactional SQL migration runner
  routes/link.routes.js          API endpoint registration
  controllers/link.controller.js HTTP input/output
  services/link.service.js       Short codes and link business rules
  repositories/link.repository.js Parameterized PostgreSQL queries
  models/link.model.js           Database row to domain model mapping
  validators/link.validator.js  Request schemas
  middleware/
    auth.js                      Constant-time API key verification
    validate.js                  Request validation
    rate-limit.js                Per-IP request limits
    error-handler.js             Consistent safe error responses
  utils/app-error.js              Expected application errors
migrations/                      Versioned SQL schema
scripts/                         Migration and local database test commands
tests/                           Service and HTTP tests
tests/integration/               Real PostgreSQL integration tests
```

Request flow: route -> middleware -> controller -> service -> repository -> PostgreSQL.

The application factory receives dependencies, so tests can replace storage without starting the production server. PostgreSQL is the source of truth: its primary key handles alias conflicts, and a single conditional UPDATE checks expiry and increments click counts atomically.

## API

Every `/api/v1/links` endpoint requires the `x-api-key` header. This is a single-owner/backend service: anyone with the key can manage all links. Never embed the key in a public frontend. Redirects do not require authentication.

| Method | Path | Behavior |
| --- | --- | --- |
| POST | /api/v1/links | Create a short link |
| GET | /api/v1/links?limit=20&cursor=... | List links using indexed cursor pagination |
| GET | /api/v1/links/:code | Get a link and click statistics |
| DELETE | /api/v1/links/:code | Delete a link (204) |
| GET | /:code | Redirect (302) and record a click |
| HEAD | /:code | Redirect headers without counting a click |
| GET | /health | Process health |
| GET | /ready | Database readiness (200 or 503) |

Create a link in PowerShell (replace the key):

```powershell
$headers = @{ 'x-api-key' = 'YOUR_API_KEY' }
$body = @{
  originalUrl = 'https://example.com/a/long/path?campaign=launch'
  customAlias = 'launch'
  # Optional: expiresAt = '2030-12-31T23:59:59Z'
} | ConvertTo-Json

$link = Invoke-RestMethod -Method Post -Uri 'http://localhost:3000/api/v1/links' -Headers $headers -ContentType 'application/json' -Body $body
$link.data.shortUrl

Invoke-RestMethod -Uri 'http://localhost:3000/api/v1/links/launch' -Headers $headers
```

Only `originalUrl` is required. URLs must use HTTP(S), have no embedded credentials, and be at most 2048 characters. Custom aliases are case-sensitive, 4-32 letters, digits, underscores, or hyphens; health/ready and other reserved aliases are rejected. Automatic codes use 72 cryptographically random bits and retry database collisions. Expiry timestamps must be ISO 8601 with a timezone and in the future.

Success responses use `{ "success": true, "data": ... }`. Errors use:

```json
{
  "success": false,
  "error": { "code": "LINK_NOT_FOUND", "message": "Short link not found" },
  "requestId": "request-uuid"
}
```

Status codes include 400 (invalid request), 401 (API key), 404 (missing), 409 (alias taken), 410 (expired), 413 (body too large), and 429 (rate limit).

Expired links remain available to management and keep their alias reserved. Deleted aliases stay permanently reserved to prevent stale redirects or analytics being attributed to a new owner. GET redirects count requests, including bots, rather than unique visitors. Redirects and management responses use `Cache-Control: no-store` so caches do not bypass expiry and click counting.

## Configuration

| Setting | Purpose |
| --- | --- |
| DATABASE_URL | PostgreSQL connection URI; use your provider's verified TLS configuration for hosted databases |
| API_KEY | Required shared secret, at least 32 characters |
| BASE_URL | Public HTTP(S) origin used to construct short links |
| PORT | HTTP port, defaults to 3000 |
| DB_POOL_MAX | Maximum database connections per app process, defaults to 20 |
| CORS_ORIGINS | Comma-separated allowed browser origins; empty disables cross-origin access |
| TRUST_PROXY_HOPS | Defaults to 0; configure only for your known proxy topology |
| RATE_LIMIT_WINDOW_MS | Rate limit window, defaults to 60000 |
| API_RATE_LIMIT | Management requests per IP per window, defaults to 60 |
| REDIRECT_RATE_LIMIT | Redirect requests per IP per window, defaults to 300 |
| LOG_LEVEL | Defaults to info |
| NODE_ENV | development, test, or production |

Requests have generated IDs. Logs omit API keys, bodies, destination URLs, and query strings. Error responses do not expose database details.

## Tests

```powershell
npm test
# Real database tests create and drop a randomly named schema in this database:
$env:TEST_DATABASE_URL = 'postgresql://user:password@localhost:5432/shortener_test'
npm run test:integration
```

The database user needs permission to create schemas. The integration suite verifies migrations, simultaneous alias creation, concurrent click increments, expiry, and the API lifecycle. Without `TEST_DATABASE_URL`, it reports a skipped test.

Alternatively, with PostgreSQL command-line binaries installed:

```powershell
# Only needed if PostgreSQL binaries are not on PATH:
$env:PG_BIN = 'C:\Program Files\PostgreSQL\18\bin'
npm run test:postgres:local
```

This starts a temporary cluster bound to loopback on an available port, runs integration tests, and stops/removes its own cluster afterward. It does not use your application database.

## Deployment notes

Run migrations as a deployment step, then `npm start`. Put the API behind HTTPS and configure proxy trust for your actual network. SIGINT/SIGTERM stop accepting requests, drain in-flight work, and close the database pool with a 10-second shutdown deadline.

Rate limits are held in each process's memory. Before horizontal scaling, use a shared rate-limit store and budget database connections across all replicas. Click counting writes synchronously to PostgreSQL; higher traffic may warrant asynchronous analytics. Pagination uses the indexed (created_at, code) cursor. page=1 is accepted for compatibility; higher page numbers are rejected. This project does not include user accounts, destination malware scanning, or a public frontend.

Reference: [node-postgres parameterized queries](https://node-postgres.com/features/queries), [Express error handling](https://expressjs.com/en/guide/error-handling/).

## Scaling foundations

Set REDIS_URL for shared limits across replicas (required in production). The cache uses bounded TTLs, negative entries, and deletion tombstones. /metrics requires the API key. Each process bounds in-flight requests and database connections. Further deployment and load-test documentation accompanies the worker rollout.

## Multi-instance deployment

Set API_KEY, BASE_URL, and a URL-safe POSTGRES_PASSWORD in .env, then run:

```powershell
docker compose -f compose.scale.yaml up -d --build --scale api=3 --scale worker=2
```

The gateway listens on 127.0.0.1:8080; use an HTTPS ingress in production. PostgreSQL and Redis have no published ports in this stack. Migrations finish before API and worker startup. Shared Redis limits work across replicas.

With Redis enabled, redirects enqueue clicks into 16 streams and workers batch updates. Counts are eventually consistent. Each partition checkpoint and its count updates commit in the same PostgreSQL transaction. Uncommitted events are never trimmed. The queue is bounded; enqueue failure/full queue preserves redirects but increments dropped-event metrics. Redis must use noeviction and persistent storage; the sample uses AOF every second, which can lose about one second of events on a Redis crash. Redis rate-limit failure returns 503.

Run npm run worker alongside npm start when running without Docker but with REDIS_URL configured. For a complete container smoke test, build the image then run npm run test:compose.
