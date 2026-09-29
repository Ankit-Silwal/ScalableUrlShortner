import Redis from 'ioredis';

export function createRedis(config, logger) {
  if (!config.REDIS_URL) return null;
  const client = new Redis(config.REDIS_URL, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 0,
    autoResendUnfulfilledCommands: false,
    commandTimeout: config.REDIS_TIMEOUT_MS,
    connectTimeout: 2000,
    retryStrategy: (attempt) => Math.min(100 * attempt, 2000),
  });
  client.on('error', () => logger?.warn('Redis connection unavailable'));
  return client;
}
