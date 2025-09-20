import { routes } from './handlers.js';

export default {
  async fetch(request, env) {
    const pathname = new URL(request.url).pathname;
    
    for (const route of routes) {
      const match = pathname.match(route.pattern);
      if (match) {
        return route.handler(request, ...match.slice(1));
      }
    }
    
    return new Response('Not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
