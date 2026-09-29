import { AppError } from '../utils/app-error.js';

export const validate = (schema, source = 'body') => (req, res, next) => {
  const result = schema.safeParse(req[source]);
  if (!result.success) {
    return next(new AppError(400, 'VALIDATION_ERROR', 'Invalid request data', result.error.issues.map((issue) => ({
      field: issue.path.join('.'), message: issue.message,
    }))));
  }
  req.validated = { ...req.validated, [source]: result.data };
  next();
};
