import { Router } from 'express';
import { makeApiController } from '../controllers/api';
import { AppContext } from '../app';

export const makeApiRoutes = (ctx: AppContext): Router => {
  const router = Router();
  const controller = makeApiController(ctx);

  router.get('/tags', controller.getTags);
  router.post('/show', controller.getModelInfo);
  router.post('/chat', controller.chatCompletion);

  return router;
};
