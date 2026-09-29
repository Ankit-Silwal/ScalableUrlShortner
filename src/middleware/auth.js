import { createHash, timingSafeEqual } from 'node:crypto';
import { AppError } from '../utils/app-error.js';

const digest = (value) => createHash('sha256').update(value).digest();
export const requireApiKey = (key) => {
  const expected = digest(key);
  return (req, res, next) => {
    const supplied = req.get('x-api-key');
    if (!supplied || !timingSafeEqual(expected, digest(supplied))) {
      return next(new AppError(401, 'UNAUTHORIZED', 'A valid x-api-key header is required'));
    }
    next();
  };
};
