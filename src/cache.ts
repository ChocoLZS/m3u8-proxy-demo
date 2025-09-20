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

// 全局缓存
export const cache = new Map<string, Content>();
export const responseCache = new Map<string, CacheItem>();
export const argsCache = new Map<string, CacheItem>();

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
  cacheMap: Map<string, CacheItem> = responseCache
): Promise<{ data: string; response: Response }> {
  const now = Date.now();
  const cacheKey = url;
  
  // 检查缓存是否有效
  const cached = cacheMap.get(cacheKey);
  if (cached && cached.expiredAt > now) {
    const data = cached.processedData || cached.data;
    // 创建模拟响应对象
    const response = new Response(data, {
      status: 200,
      headers: { 'Content-Type': 'application/x-mpegURL' }
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
  cacheMap.set(cacheKey, cacheItem);
  
  return { 
    data: processedData, 
    response: new Response(processedData, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    })
  };
}