import express, { Express } from 'express';
import { Middleware } from './middleware';
import { makeApiRoutes } from './routes/api';
import { Config } from './config';
import { ModelConfig } from './data/models';
import OpenAI from 'openai';

export interface AppContext {
  middleware: Middleware;
  config: Config;
  models: ModelConfig[];
  openai: OpenAI;
}

export function makeApp(ctx: AppContext): Express {
  const app = express();
  app.use(express.json({ limit: '100mb' }));
  app.use(ctx.middleware.logger);

  app.use('/api', makeApiRoutes(ctx));

  app.use(ctx.middleware.routeNotFound);
  app.use(ctx.middleware.errorHandler);

  return app;
}
