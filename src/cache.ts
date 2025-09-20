export interface CacheItem {
  data: string;
  expiredAt: number; // 毫秒时间戳，Infinity 表示永不过期
  processedData?: string; // 处理后的数据
}

export interface Content {
  origin_url: string;
  proxied_playlist_url?: string;
  proxied_playlist?: string;
}

export type TextProcessor = (text: string, url: string, baseUrl?: URL, params?: any) => string;

// Durable Object 缓存接口
export interface DurableCache {
  getContent(id: string): Promise<Content | null>;
  setContent(id: string, content: Content): Promise<void>;
  getCacheItem(key: string): Promise<CacheItem | null>;
  setCacheItem(key: string, item: CacheItem): Promise<void>;
  deleteCacheItem(key: string): Promise<void>;
}

// Durable Object 缓存实现
export class DurableObjectCache implements DurableCache {
  private cacheStorage: DurableObjectStub;

  constructor(cacheStorage: DurableObjectStub) {
    this.cacheStorage = cacheStorage;
  }

  async getContent(id: string): Promise<Content | null> {
    const response = await this.cacheStorage.fetch(`https://cache/content/${id}`);
    const result = await response.json();
    return result || null;
  }

  async setContent(id: string, content: Content): Promise<void> {
    await this.cacheStorage.fetch(`https://cache/content/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(content)
    });
  }

  async getCacheItem(key: string): Promise<CacheItem | null> {
    const response = await this.cacheStorage.fetch(`https://cache/cache/${encodeURIComponent(key)}`);
    const result = await response.json();
    return result || null;
  }

  async setCacheItem(key: string, item: CacheItem): Promise<void> {
    await this.cacheStorage.fetch(`https://cache/cache/${encodeURIComponent(key)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(item)
    });
  }

  async deleteCacheItem(key: string): Promise<void> {
    await this.cacheStorage.fetch(`https://cache/cache/${encodeURIComponent(key)}`, {
      method: 'DELETE'
    });
  }
}

// 全局缓存（保留作为后备）
export const cache = new Map<string, Content>();
export const responseCache = new Map<string, CacheItem>();
export const argsCache = new Map<string, CacheItem>();

export function createCorsHeaders(): Headers {
  const headers = new Headers();
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  return headers;
}

export function addCorsHeaders(response: Response): Response {
  const corsHeaders = createCorsHeaders();
  const newHeaders = new Headers(response.headers);
  
  for (const [key, value] of corsHeaders.entries()) {
    newHeaders.set(key, value);
  }
  
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders
  });
}

export function extractTTLFromM3U8(text: string): number {
  // 如果是回放内容，永久缓存
  if (text.includes('#EXT-X-ENDLIST')) {
    return Infinity;
  }
  
  // 从 #EXTINF 提取分片时长作为缓存时间
  const extinfMatch = text.match(/#EXTINF:([0-9.]+)/);
  if (extinfMatch) {
    const segmentDuration = parseFloat(extinfMatch[1]);
    return Math.floor(segmentDuration * 1000); // 转换为毫秒
  }
  
  return 6000; // 默认6秒
}

export async function getOrFetch(
  url: string,
  ttlMs: number | 'auto' = Infinity,
  processor?: TextProcessor,
  processorArgs?: { baseUrl: URL; params: any },
  cacheMap: Map<string, CacheItem> | DurableCache = responseCache
): Promise<{ data: string; response: Response }> {
  const now = Date.now();
  const cacheKey = url;
  
  // 检查缓存是否有效
  let cached: CacheItem | null = null;
  if (cacheMap instanceof Map) {
    cached = cacheMap.get(cacheKey) || null;
  } else {
    cached = await cacheMap.getCacheItem(cacheKey);
  }
  
  if (cached && cached.expiredAt > now) {
    const data = cached.processedData || cached.data;
    // 创建模拟响应对象
    const headers = createCorsHeaders();
    headers.set('Content-Type', 'application/x-mpegURL');
    const response = new Response(data, {
      status: 200,
      headers
    });
    return { data, response };
  }
  
  // 缓存过期或不存在，重新获取
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch: ${response.status}`);
  }
  
  const text = await response.text();
  let processedData = text;
  
  // 如果提供了处理器，处理文本内容
  if (processor && processorArgs) {
    processedData = processor(text, url, processorArgs.baseUrl, processorArgs.params);
  }
  
  // 自动计算 TTL
  let finalTtl = ttlMs;
  if (ttlMs === 'auto') {
    finalTtl = extractTTLFromM3U8(text);
  }
  
  // 存储到缓存
  const cacheItem: CacheItem = {
    data: text,
    expiredAt: finalTtl === Infinity ? Infinity : now + (finalTtl as number),
    processedData: processor ? processedData : undefined
  };
  
  if (cacheMap instanceof Map) {
    cacheMap.set(cacheKey, cacheItem);
  } else {
    await cacheMap.setCacheItem(cacheKey, cacheItem);
  }
  
  return { 
    data: processedData, 
    response: addCorsHeaders(new Response(processedData, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    }))
  };
}