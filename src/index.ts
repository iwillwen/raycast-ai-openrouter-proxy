import OpenAI from 'openai';
import { makeApp } from './app';
import { getConfig } from './config';
import { loadModels } from './data/models';
import { makeLogger } from './logger';
import { makeMiddleware } from './middleware';

async function main() {
  const config = getConfig();
  const models = loadModels();
  const logger = makeLogger();
  const middleware = makeMiddleware(logger);
  const openai = new OpenAI({
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey: config.apiKey,
  });
  const app = makeApp({ config, middleware, models, openai });

  app.listen(config.port, () => {
    logger.info(`Server is up on port ${config.port}`);
  });
}

main().catch((error) => {
  console.log(error);
  process.exit(1);
});
