// backend/src/metrics.ts
import express from 'express';
import client from 'prom-client';

// Create a new Registry to register all metrics
const register = new client.Registry();

// Define Prometheus metrics
export const tradeCount = new client.Counter({
  name: 'bot_trade_count',
  help: 'Number of trades executed by the bot',
});

export const errorCount = new client.Counter({
  name: 'bot_error_count',
  help: 'Number of errors occurred during trading',
});

export const healthGauge = new client.Gauge({
  name: 'bot_health_status',
  help: 'Health status of the bot (1 = healthy, 0 = unhealthy)',
});

// Register the metrics
register.registerMetric(tradeCount);
register.registerMetric(errorCount);
register.registerMetric(healthGauge);

// Optional: expose default system metrics (CPU, memory, etc.)
client.collectDefaultMetrics({ register });

// Create a router for exposing metrics
export const metricsRouter = express.Router();

metricsRouter.get('/metrics', async (_req, res) => {
  try {
    res.set('Content-Type', register.contentType);
    res.end(await register.metrics());
  } catch (err) {
    res.status(500).end(err instanceof Error ? err.message : 'Unknown error');
  }
});
