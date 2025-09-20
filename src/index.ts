import { routes, Env } from './handlers.js';
import { CacheStorage } from './durable-cache.js';

export { CacheStorage };

export default {
  async fetch(request, env) {
    const pathname = new URL(request.url).pathname;
    
    for (const route of routes) {
      const match = pathname.match(route.pattern);
      if (match) {
        return route.handler(request, ...match.slice(1), env);
      }
    }
    
    return new Response('Not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
