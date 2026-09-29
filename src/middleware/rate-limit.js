import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
import { AppError } from '../utils/app-error.js';

// Increment and expiry are one operation, shared by every API replica.
const incrementScript = `
  local count = redis.call('INCR', KEYS[1])
  if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
  return {count, redis.call('PTTL', KEYS[1])}
`;

export function createLimiter(windowMs, limit, { redis, prefix = 'shortener:rate' } = {}) {
  const limited = (req, res) => res.status(429).json({
    success: false,
    error: { code: 'RATE_LIMITED', message: 'Too many requests. Please try again later.' },
    requestId: req.id,
  });
  if (!redis) return rateLimit({
    windowMs, limit, standardHeaders: 'draft-8', legacyHeaders: false, handler: limited,
  });
  return async (req, res, next) => {
    try {
      const key = prefix + ':' + ipKeyGenerator(req.ip);
      const [count, ttl] = await redis.eval(incrementScript, 1, key, String(windowMs));
      res.set('RateLimit-Limit', String(limit));
      res.set('RateLimit-Remaining', String(Math.max(0, limit - count)));
      res.set('RateLimit-Reset', String(Math.max(1, Math.ceil(ttl / 1000))));
      if (count > limit) {
        res.set('Retry-After', String(Math.max(1, Math.ceil(ttl / 1000))));
        return limited(req, res);
      }
      next();
    } catch {
      // Fail closed instead of multiplying the limit or flooding PostgreSQL.
      next(new AppError(503, 'RATE_LIMIT_UNAVAILABLE', 'Request protection is temporarily unavailable'));
    }
  };
}
