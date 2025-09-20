import { argsCache, CacheItem } from './cache.js';

export interface CookieGroup {
  path: string;
  cookies: {
    policy: string;
    signature: string;
    keyPairId: string;
  };
}

export function getCookieGroups(response: Response): CookieGroup[] {
  const setCookieHeaders = response.headers.getSetCookie();
  const cookies = [];
  
  for (const cookieStr of setCookieHeaders) {
    const parts = cookieStr.split(';');
    if (parts.length === 0) continue;
    
    const [nameValue] = parts;
    const [name, value] = nameValue.split('=', 2);
    if (!name || !value) continue;
    
    const pathMatch = cookieStr.match(/path=([^;]+)/i);
    const path = pathMatch ? pathMatch[1].trim() : undefined;
    
    cookies.push({
      name: name.trim(),
      value: decodeURIComponent(value.trim()),
      path
    });
  }

  const groupedCookies = new Map();
  for (const cookie of cookies) {
    const path = cookie.path || '/';
    if (!groupedCookies.has(path)) {
      groupedCookies.set(path, []);
    }
    groupedCookies.get(path).push(cookie);
  }

  const cookieGroups = [];
  for (const [path, pathCookies] of groupedCookies) {
    if (path.includes('/out/v1')) {
      const params = {} as any;
      
      for (const cookie of pathCookies) {
        switch (cookie.name) {
          case 'CloudFront-Policy':
            params.policy = cookie.value;
            break;
          case 'CloudFront-Signature':
            params.signature = cookie.value;
            break;
          case 'CloudFront-Key-Pair-Id':
            params.keyPairId = cookie.value;
            break;
        }
      }
      
      if (params.policy && params.signature && params.keyPairId) {
        cookieGroups.push({
          path,
          cookies: params
        });
      }
    }
  }
  return cookieGroups;
}

export function parseM3u8Content(html: string): {
  liveStatusCode?: string;
  listChannels?: string[];
} {
  const liveStatusCode = html.match(/"delivery_status":"([^"]+)"/)?.[1];
  let listChannels: string[] = [];
  
  if (liveStatusCode === "CONFIRMED_ARCHIVE") {
    const listChannelsMatch = html.match(/var listChannels = (\[.*?\]);/)?.[1];
    if (listChannelsMatch) {
      try {
        const parsedChannels = JSON.parse(listChannelsMatch.replace(/\\/g, ''));
        if (Array.isArray(parsedChannels)) {
          listChannels = parsedChannels;
        }
      } catch (error) {
        console.error('Failed to parse listChannels:', error);
      }
    }
  }
  
  return { liveStatusCode, listChannels };
}

export async function getArgs(originUrl: string): Promise<Record<string, any>> {
  const now = Date.now();
  const cacheKey = originUrl;
  
  // 检查缓存是否有效
  const cached = argsCache.get(cacheKey);
  if (cached && cached.expiredAt > now) {
    return JSON.parse(cached.processedData || cached.data);
  }
  
  // 缓存过期或不存在，重新获取
  const response = await fetch(originUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36 Edg/137.0.0.0'
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch args: ${response.status}`);
  }

  const html = await response.text();
  if (!html) {
    throw new Error('Empty response');
  }

  const cookieGroups = getCookieGroups(response);
  const { liveStatusCode, listChannels } = parseM3u8Content(html);
  
  let args: Record<string, any> = { cookieGroups };
  
  if (liveStatusCode === "CONFIRMED_ARCHIVE" && listChannels.length > 0) {
    const m3u8Url = listChannels[0];
    const baseUrl = new URL(m3u8Url);
    args = { cookieGroups, baseUrl };
  }
  
  // 存储到缓存
  const cacheItem: CacheItem = {
    data: html,
    expiredAt: now + 55 * 60 * 1000, // 55分钟
    processedData: JSON.stringify(args)
  };
  argsCache.set(cacheKey, cacheItem);
  
  return args;
}

export function createM3u8Processor(baseUrl: URL, params: any) {
  return (text: string): string => {
    return text.replace(/^(.*\.ts)$/gm, (match, tsFileName) => {
      const tsUrl = new URL(baseUrl.toString());
      const tsParts = tsUrl.pathname.split('/');
      tsParts[tsParts.length - 1] = tsFileName;
      tsUrl.pathname = tsParts.join('/');
      
      if (params) {
        tsUrl.searchParams.set('Policy', params.policy);
        tsUrl.searchParams.set('Signature', params.signature);
        tsUrl.searchParams.set('Key-Pair-Id', params.keyPairId);
      }
      
      return tsUrl.toString();
    });
  };
}

export async function fetchM3u8Playlist(originUrl: string): Promise<{
  playlistUrl?: string;
  playlist?: string;
  args?: Record<string, any>;
}> {
  const response = await fetch(originUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36 Edg/137.0.0.0'
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch URL: ${response.status}`);
  }

  const html = await response.text();
  if (!html) {
    throw new Error('Empty response');
  }

  const cookieGroups = getCookieGroups(response);
  const { liveStatusCode, listChannels } = parseM3u8Content(html);
  
  if (liveStatusCode === "CONFIRMED_ARCHIVE" && listChannels.length > 0) {
    const m3u8Url = listChannels[0];
    const url = new URL(m3u8Url);
    const params = cookieGroups.find(group => m3u8Url.includes(group.path))?.cookies;
    
    if (params) {
      url.searchParams.set('Policy', params.policy);
      url.searchParams.set('Signature', params.signature);
      url.searchParams.set('Key-Pair-Id', params.keyPairId);
    }
    
    const playlistResponse = await fetch(url.toString());
    const playlist = await playlistResponse.text();
    
    return {
      playlistUrl: url.toString(),
      playlist,
      args: { cookieGroups, baseUrl: url }
    };
  }
  
  return {};
}