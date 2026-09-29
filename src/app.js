import { admissionLimit } from './middleware/admission.js';
import { observeRequests } from './infrastructure/metrics.js';
import { randomUUID } from 'node:crypto';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import pinoHttp from 'pino-http';
import { requireApiKey } from './middleware/auth.js';
import { createLimiter } from './middleware/rate-limit.js';
import { errorHandler, notFound } from './middleware/error-handler.js';
import { validate } from './middleware/validate.js';
import { codeParamsSchema } from './validators/link.validator.js';
import { LinkService } from './services/link.service.js';
import { createLinkController } from './controllers/link.controller.js';
import { linkRoutes } from './routes/link.routes.js';

export function createApp({ config, repository, logger, redis, cache, analytics, metrics, isReady = () => true }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.TRUST_PROXY_HOPS);
  app.use(pinoHttp({
    logger, autoLogging: config.HTTP_LOG_ENABLED, genReqId: () => randomUUID(),
    // Avoid logging API keys, destination URLs, query strings, or request bodies.
    serializers: { req: (req) => ({ id: req.id, method: req.method }), res: (res) => ({ statusCode: res.statusCode }) },
  }));
  app.use((req, res, next) => {
    res.set('X-Request-Id', req.id);
    res.set('Cache-Control', 'no-store');
    next();
  });
  app.use(helmet());
  app.use(cors({ origin: config.CORS_ORIGINS.length ? config.CORS_ORIGINS : false }));
  app.get('/health', (req, res) => res.json({ status: 'ok' }));
  app.get('/ready', async (req, res) => {
    const ready = await isReady();
    res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'unavailable' });
  });
  if (metrics) app.get('/metrics', requireApiKey(config.API_KEY), async (req, res) => res.type(metrics.registry.contentType).send(await metrics.registry.metrics()));
  app.use(admissionLimit(config.MAX_INFLIGHT_REQUESTS));
  if (metrics) app.use(observeRequests(metrics));
  app.get('/', (req, res) => res.json({ name: 'URL Shortener API', version: '1.0.0', links: '/api/v1/links' }));
  const controller = createLinkController(new LinkService(repository, config.BASE_URL, undefined, { cache, analytics, metrics }));
  app.use('/api/v1/links', createLimiter(config.RATE_LIMIT_WINDOW_MS, config.API_RATE_LIMIT, { redis, prefix: config.REDIS_PREFIX + ':rate:api' }),
    requireApiKey(config.API_KEY), express.json({ limit: '16kb' }), linkRoutes(controller));
  app.get('/:code', createLimiter(config.RATE_LIMIT_WINDOW_MS, config.REDIRECT_RATE_LIMIT, { redis, prefix: config.REDIS_PREFIX + ':rate:redirect' }),
    validate(codeParamsSchema, 'params'), controller.redirect);
  app.use(notFound);
  app.use(errorHandler);
  return app;
}
