import { createMiddleware } from 'hono/factory';

export const requestId = () => {
  return createMiddleware(async (c, next) => {
    const id = c.req.header('X-Request-Id') || crypto.randomUUID();
    c.set('requestId', id);
    c.header('X-Request-Id', id);
    await next();
  });
};
