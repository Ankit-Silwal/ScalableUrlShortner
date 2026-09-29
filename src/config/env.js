import 'dotenv/config';
import { z } from 'zod';

const positiveInteger = (fallback) => z.coerce.number().int().positive().default(fallback);
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: positiveInteger(3000).refine((port) => port <= 65535),
  BASE_URL: z.url().refine((value) => {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      && url.pathname === '/' && !url.search && !url.hash;
  }, 'Must be an HTTP(S) origin without a path, query, or credentials'),
  DATABASE_URL: z.string().regex(/^postgres(?:ql)?:\/\//),
  DB_POOL_MAX: positiveInteger(10),
  DB_QUERY_TIMEOUT_MS: positiveInteger(2000),
  REDIS_URL: z.union([z.string().regex(/^rediss?:\/\//), z.literal('')]).default(''),
  REDIS_PREFIX: z.string().regex(/^[a-zA-Z0-9:_-]{1,64}$/).default('shortener'),
  REDIS_TIMEOUT_MS: positiveInteger(500),
  ANALYTICS_STREAM_MAX_LENGTH: positiveInteger(100000),
  ANALYTICS_BATCH_SIZE: z.coerce.number().int().min(1).max(5000).default(500),
  ANALYTICS_POLL_MS: positiveInteger(200),
  WORKER_PORT: positiveInteger(9100).refine((port) => port <= 65535),
  CACHE_TTL_SECONDS: z.coerce.number().int().min(1).max(300).default(60),
  MAX_INFLIGHT_REQUESTS: positiveInteger(500),
  HTTP_LOG_ENABLED: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  API_KEY: z.string().min(32),
  CORS_ORIGINS: z.string().default(''),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).default(0),
  RATE_LIMIT_WINDOW_MS: positiveInteger(60000),
  API_RATE_LIMIT: positiveInteger(60),
  REDIRECT_RATE_LIMIT: positiveInteger(300),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export function loadConfig(environment = process.env) {
  const result = schema.superRefine((config, ctx) => {
    if (config.NODE_ENV === 'production' && !config.REDIS_URL) ctx.addIssue({ code: 'custom', path: ['REDIS_URL'], message: 'Redis is required in production' });
  }).safeParse(environment);
  if (!result.success) {
    throw new Error(`Invalid environment configuration: ${[...new Set(result.error.issues.map((issue) => issue.path.join('.')))].join(', ')}. Check .env.example.`);
  }
  return {
    ...result.data,
    BASE_URL: new URL(result.data.BASE_URL).origin,
    CORS_ORIGINS: result.data.CORS_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean),
  };
}
