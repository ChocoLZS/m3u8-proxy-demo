import { cache, getOrFetch } from './cache.js';
import { getArgs, fetchM3u8Playlist, createM3u8Processor } from './parser.js';

export async function handleApi(request: Request, id: string): Promise<Response> {
  const url = new URL(request.url);
  const apiUrl = url.searchParams.get("url");
  
  if (!apiUrl) {
    return new Response("Missing url parameter", { status: 400 });
  }
  
  const cached = cache.get(id);
  if (!cached || cached.origin_url !== apiUrl) {
    cache.set(id, { origin_url: apiUrl });
  }
  
  // return new Response(JSON.stringify({ url: apiUrl }), { 
  //   headers: { 'Content-Type': 'application/json' } 
  // });
  return Response.redirect(`${url.origin}/api/${id}/index.m3u8`, 302);
}

export async function handleM3u8(request: Request, id: string): Promise<Response> {
  const cached = cache.get(id);
  if (!cached) {
    return new Response("ID not found. Please register first via /api/{id}?url=", { status: 404 });
  }
  
  if (!cached.proxied_playlist_url || !cached.proxied_playlist) {
    try {
      const result = await fetchM3u8Playlist(cached.origin_url);
      if (result.playlistUrl && result.playlist) {
        cached.proxied_playlist_url = result.playlistUrl;
        cached.proxied_playlist = result.playlist;
      } else {
        return new Response("Failed to fetch playlist", { status: 500 });
      }
    } catch (error) {
      return new Response(`Error fetching playlist: ${(error as Error).message}`, { status: 500 });
    }
  }
  
  return new Response(cached.proxied_playlist, {
    headers: { "Content-Type": "application/x-mpegURL" }
  });
}

export async function handleSegments(request: Request, id: string, segments: string): Promise<Response> {
  const cached = cache.get(id);
  if (!cached) {
    return new Response("ID not found", { status: 404 });
  }
  
  if (!cached.proxied_playlist || !cached.proxied_playlist_url) {
    return new Response("Playlist not available. Please fetch /index.m3u8 first", { status: 404 });
  }
  
  if (!cached.proxied_playlist.includes(segments)) {
    return new Response("Segment not found in playlist", { status: 404 });
  }

  if (!segments.endsWith(".m3u8")) {
    return new Response("Only .m3u8 segments are supported", { status: 400 });
  }
  
  try {
    // 使用 getArgs 获取带 55 分钟缓存的 args
    const args = await getArgs(cached.origin_url);
    const cookieGroups = args.cookieGroups;
    const baseUrl = new URL(cached.proxied_playlist_url);
    
    // 构建段文件URL
    const pathParts = baseUrl.pathname.split('/');
    pathParts[pathParts.length - 1] = segments;
    const segmentUrl = new URL(baseUrl.toString());
    segmentUrl.pathname = pathParts.join('/');
    
    const params = cookieGroups.find((group: any) => segmentUrl.toString().includes(group.path))?.cookies;
    if (params) {
      segmentUrl.searchParams.set('Policy', params.policy);
      segmentUrl.searchParams.set('Signature', params.signature);
      segmentUrl.searchParams.set('Key-Pair-Id', params.keyPairId);
    }
    
    // m3u8 文本处理器：替换 ts 文件引用为带认证参数的完整URL
    const m3u8Processor = createM3u8Processor(baseUrl, params);
    
    const { data: updatedText, response: segmentResponse } = await getOrFetch(
      segmentUrl.toString(),
      'auto', // 自动从内容中提取 TTL
      m3u8Processor,
      { baseUrl, params }
    );
    
    const responseHeaders = new Headers(segmentResponse.headers);
    responseHeaders.delete('Content-Length');
    
    return new Response(updatedText, {
      status: segmentResponse.status,
      statusText: segmentResponse.statusText,
      headers: responseHeaders
    });
  } catch (error) {
    console.error(`Failed to fetch segment: ${(error as Error).message}`);
    return new Response("Failed to fetch segment", { status: 500 });
  }
}

export interface Route {
  pattern: RegExp;
  handler: (request: Request, ...args: string[]) => Promise<Response>;
}

export const routes: Route[] = [
  { pattern: /^\/api\/([^\/]+)$/, handler: handleApi },
  { pattern: /^\/api\/([^\/]+)\/index\.m3u8$/, handler: handleM3u8 },
  { pattern: /^\/api\/([^\/]+)\/(.+)$/, handler: handleSegments },
];