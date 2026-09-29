import { rateLimit } from 'express-rate-limit';

export const createLimiter = (windowMs, limit) => rateLimit({
  windowMs, limit, standardHeaders: 'draft-8', legacyHeaders: false,
  handler: (req, res) => res.status(429).json({
    success: false,
    error: { code: 'RATE_LIMITED', message: 'Too many requests. Please try again later.' },
    requestId: req.id,
  }),
});
