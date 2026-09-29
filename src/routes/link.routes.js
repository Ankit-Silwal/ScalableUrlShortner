import { Router } from 'express';
import { validate } from '../middleware/validate.js';
import { codeParamsSchema, createLinkSchema, listQuerySchema } from '../validators/link.validator.js';

export function linkRoutes(controller) {
  const router = Router();
  router.post('/', validate(createLinkSchema), controller.create);
  router.get('/', validate(listQuerySchema, 'query'), controller.list);
  router.get('/:code', validate(codeParamsSchema, 'params'), controller.get);
  router.delete('/:code', validate(codeParamsSchema, 'params'), controller.delete);
  return router;
}
