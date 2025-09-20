import { Content, CacheItem } from './cache.js';

export interface Env {
  CACHE_STORAGE: DurableObjectNamespace;
}

export class CacheStorage {
  private state: DurableObjectState;
  private env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;
    const pathParts = url.pathname.split('/').filter(Boolean);

    try {
      switch (method) {
        case 'GET':
          if (pathParts[0] === 'content') {
            // GET /content/{id}
            const id = pathParts[1];
            const content = await this.state.storage.get<Content>(`content:${id}`);
            return new Response(JSON.stringify(content || null), {
              headers: { 'Content-Type': 'application/json' }
            });
          } else if (pathParts[0] === 'cache') {
            // GET /cache/{key}
            const key = pathParts[1];
            const cacheItem = await this.state.storage.get<CacheItem>(`cache:${key}`);
            
            // 检查是否过期
            if (cacheItem && cacheItem.expiredAt !== Infinity && cacheItem.expiredAt <= Date.now()) {
              await this.state.storage.delete(`cache:${key}`);
              return new Response(JSON.stringify(null), {
                headers: { 'Content-Type': 'application/json' }
              });
            }
            
            return new Response(JSON.stringify(cacheItem || null), {
              headers: { 'Content-Type': 'application/json' }
            });
          }
          break;

        case 'PUT':
          if (pathParts[0] === 'content') {
            // PUT /content/{id}
            const id = pathParts[1];
            const content: Content = await request.json();
            await this.state.storage.put(`content:${id}`, content);
            return new Response('OK');
          } else if (pathParts[0] === 'cache') {
            // PUT /cache/{key}
            const key = pathParts[1];
            const cacheItem: CacheItem = await request.json();
            await this.state.storage.put(`cache:${key}`, cacheItem);
            return new Response('OK');
          }
          break;

        case 'DELETE':
          if (pathParts[0] === 'content') {
            // DELETE /content/{id}
            const id = pathParts[1];
            await this.state.storage.delete(`content:${id}`);
            return new Response('OK');
          } else if (pathParts[0] === 'cache') {
            // DELETE /cache/{key}
            const key = pathParts[1];
            await this.state.storage.delete(`cache:${key}`);
            return new Response('OK');
          }
          break;
      }

      return new Response('Not Found', { status: 404 });
    } catch (error) {
      return new Response(`Error: ${(error as Error).message}`, { status: 500 });
    }
  }
}