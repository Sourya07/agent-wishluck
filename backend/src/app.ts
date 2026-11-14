import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import { apiRouter } from './routes/api.js';
import { webhookRouter } from './routes/webhooks.js';
import { mockCourierRouter } from './courier/mockCourier.js';
import { log } from './lib/logger.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(cors());
  app.use((req, _res, next) => { if (!req.path.endsWith('/stream')) log.debug('http', { method: req.method, path: req.path }); next(); });

  app.use('/webhooks', webhookRouter());        // raw body + HMAC
  app.use('/mock-courier', mockCourierRouter()); // simulated third-party courier API
  app.use('/api', apiRouter());

  // In Docker / production the backend also serves the built React app.
  const dist = process.env.FRONTEND_DIST || path.resolve(process.cwd(), '../frontend/dist');
  if (fs.existsSync(path.join(dist, 'index.html'))) {
    app.use(express.static(dist, { index: false, maxAge: '1h' }));
    app.get(/^\/(?!api|webhooks|mock-courier).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  }

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status ?? (err.name === 'ZodError' ? 400 : 500);
    if (status >= 500) log.error('request failed', { error: err.message, stack: String(err.stack ?? '').split('\n').slice(0, 4).join(' | ') });
    res.status(status).json({ error: status >= 500 ? 'Internal error' : err.message, details: err.issues });
  });
  return app;
}
