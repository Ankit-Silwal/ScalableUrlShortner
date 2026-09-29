import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from '@prometheus-io/client';

export function createMetrics() {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry, prefix: 'shortener_' });
  const counter = (name, help, labelNames = []) => new Counter({ name, help, labelNames, registers: [registry] });
  return {
    registry,
    lag: new Gauge({ name: 'shortener_analytics_lag_seconds', help: 'Age of the oldest unprocessed event per partition', labelNames: ['partition'], registers: [registry] }),
    cache: counter('shortener_cache_total', 'Cache outcomes', ['result']),
    analytics: counter('shortener_analytics_events_total', 'Analytics enqueue outcomes', ['result']),
    batches: counter('shortener_analytics_batches_total', 'Committed analytics batches'),
    applied: counter('shortener_analytics_applied_total', 'Events applied by the worker'),
    requests: new Histogram({
      name: 'shortener_http_duration_seconds', help: 'HTTP latency with bounded route labels',
      labelNames: ['route', 'method', 'status'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
      registers: [registry],
    }),
  };
}

export const observeRequests = (metrics) => (req, res, next) => {
  const end = metrics.requests.startTimer();
  res.once('finish', () => {
    const route = req.route?.path ?? 'unmatched';
    const method = ['GET', 'HEAD', 'POST', 'DELETE', 'OPTIONS'].includes(req.method) ? req.method : 'other';
    end({ route: String(route), method, status: String(res.statusCode) });
  });
  next();
};
