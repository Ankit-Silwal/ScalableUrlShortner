import { AppError } from '../utils/app-error.js';

export function admissionLimit(maximum) {
  let active = 0;
  return (req, res, next) => {
    if (active >= maximum) {
      res.set('Retry-After', '1');
      return next(new AppError(503, 'OVERLOADED', 'Server is busy. Please retry.'));
    }
    active++;
    let released = false;
    const release = () => { if (!released) { released = true; active--; } };
    res.once('finish', release);
    res.once('close', release);
    next();
  };
}
