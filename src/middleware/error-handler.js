import { AppError } from '../utils/app-error.js';

export const notFound = (req, res, next) => next(new AppError(404, 'NOT_FOUND', 'Route not found'));

export function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);
  let error = err;
  if (err.type === 'entity.parse.failed') error = new AppError(400, 'INVALID_JSON', 'Request body must be valid JSON');
  if (err.type === 'entity.too.large') error = new AppError(413, 'PAYLOAD_TOO_LARGE', 'Request body exceeds 16 KB');
  if (err.code === '23505') error = new AppError(409, 'ALIAS_TAKEN', 'This alias is already in use');
  const known = error instanceof AppError;
  if (!known) req.log?.error({ errorType: err.name }, 'Request failed');
  res.status(known ? error.status : 500).json({
    success: false,
    error: {
      code: known ? error.code : 'INTERNAL_ERROR',
      message: known ? error.message : 'An unexpected error occurred',
      ...(known && error.details ? { details: error.details } : {}),
    },
    requestId: req.id,
  });
}
