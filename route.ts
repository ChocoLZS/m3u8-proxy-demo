import { NextRequest, NextResponse } from 'next/server';
import { cache, CACHE_KEYS, CACHE_TTL } from '@/lib/cache';

function getCookieGroups(response: Response): Array<{ path: string; cookies: { policy: string; signature: string; keyPairId: string } }> {
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

  // Group cookies by path
  const groupedCookies = new Map();
  for (const cookie of cookies) {
    const path = cookie.path || '/';
    if (!groupedCookies.has(path)) {
      groupedCookies.set(path, []);
    }
    groupedCookies.get(path).push(cookie);
  }

  // Extract CloudFront parameters from /out/v1 paths
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

let cached_url = null as URL | null;
let cached_cookie_groups = null as Array<{ path: string; cookies: { policy: string; signature: string; keyPairId: string } }> | null;

// proxy m3u8 request to the actual player URL
export async function GET(request: NextRequest, context: { params: Promise<{ segments: string[] }> }) {
  const { segments } = await context.params;
  const targetPath = segments.join('/');

  // Validate that this is an m3u8 request
  if (!targetPath.endsWith('.m3u8')) {
    return NextResponse.json({ error: 'Invalid request - must be .m3u8 file' }, { status: 400 });
  }
  const url = "https://live.eplus.jp/ex/player?ib=GZW%2BjX%2FHRH5FBIG3FVTZ6%2BhAuiKsTpAR05JjB015yJczxbFyRT5oPTRi5Lbp8AY2%2F6baLK1s2QBBv5plvcM3uA%3D%3D";
  
  // Fetch the URL to extract cookies
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36 Edg/137.0.0.0'
    }
  });

  if (!response.ok) {
    return NextResponse.json({ error: 'Failed to fetch URL' }, { status: response.status });
  }

  const html = await response.text();
    if (!html) {
    return NextResponse.json({ error: 'Empty response' }, { status: 500 });
    }
    // Extract cookies from Set-Cookie headers
    if (cached_cookie_groups && cached_url && !targetPath.endsWith('index.m3u8')) {
      const last_segment = segments[segments.length - 1];
      // replace the last segment with cached_url's pathname last segment
      const cached_splits = cached_url.pathname.split('/');
      cached_splits[cached_splits.length - 1] = last_segment;
      const new_pathname = cached_splits.join('/');
      const new_url = new URL(cached_url.toString());
      new_url.pathname = new_pathname;
      const params = cached_cookie_groups.find(group => new_url.toString().includes(group.path))?.cookies;
      if (!params) {
        return NextResponse.json({ error: 'No matching cookie group found' }, { status: 500 });
      }
      new_url.searchParams.set('Policy', params.policy);
      new_url.searchParams.set('Signature', params.signature);
      new_url.searchParams.set('Key-Pair-Id', params.keyPairId);
      console.log("Proxying to", new_url.toString());
      const proxiedResponse = await fetch(new_url.toString());
      const text = await proxiedResponse.text();
      if (!text) {
        return NextResponse.json({ error: 'Empty proxied response' }, { status: 500 });
      }
      // replace ^index_....ts to https://vod.live.eplus.jp/out/v1/523aad027c2f4759809228d4897fd632/b3596ef01477183d3dde18335ee19cc5/index_....ts?Policy=...&Signature=...&Key-Pair-Id=...
      const updatedText = text.replace(/^(index.*ts$)/gm, (match, p1) => {
        const cached_splits = cached_url!.pathname.split('/');
        cached_splits[cached_splits.length - 1] = p1;
        const ts_url = new URL(cached_url!.toString());
        ts_url.pathname = cached_splits.join('/');
        // add params
        ts_url.searchParams.set('Policy', params!.policy);
        ts_url.searchParams.set('Signature', params!.signature);
        ts_url.searchParams.set('Key-Pair-Id', params!.keyPairId);
        return ts_url.toString();
      });
      const proxiedResponseHeaders = new Headers(proxiedResponse.headers);
      // Remove security headers that might interfere
      proxiedResponseHeaders.delete('content-security-policy');
      proxiedResponseHeaders.delete('content-security-policy-report-only');
      proxiedResponseHeaders.delete('clear-site-data');
      proxiedResponseHeaders.set('Content-Length', String(Buffer.byteLength(updatedText, 'utf-8')));
      proxiedResponseHeaders.set('Content-Type', 'application/x-mpegURL');
      const response = new NextResponse(updatedText, {
        status: proxiedResponse.status,
        statusText: proxiedResponse.statusText,
        headers: proxiedResponseHeaders
      });
      return response;
    }
    cached_cookie_groups = getCookieGroups(response);
    const live_status_code = html.match(/"delivery_status":"([^"]+)"/)?.[1];
    if (live_status_code === "CONFIRMED_ARCHIVE") {
        // get var listChannels = ["https:\/\/vod.live.eplus.jp\/out\/v1\/523aad027c2f4759809228d4897fd632\/b3596ef01477183d3dde18335ee19cc5\/FNFTF_1757241181.m3u8"];
        const listChannelsMatch = html.match(/var listChannels = (\[.*?\]);/)?.[1];
        if (listChannelsMatch) {
            try {
                const listChannels = JSON.parse(listChannelsMatch.replace(/\\/g, ''));
                if (Array.isArray(listChannels) && listChannels.length > 0) {
                    const m3u8Url = listChannels[0];
                    cached_url = new URL(m3u8Url);
                    // Redirect to the extracted m3u8 URL
                    // return the result of the m3u8 
                    const params = cached_cookie_groups.find(group => m3u8Url.includes(group.path))?.cookies;
                    cached_url.searchParams.set('Policy', params?.policy || '');
                    cached_url.searchParams.set('Signature', params?.signature || '');
                    cached_url.searchParams.set('Key-Pair-Id', params?.keyPairId || '');
                    console.log("Redirecting to", cached_url.toString());
                    // fetch the m3u8 URL with the cookies
                    const m3u8Response = await fetch(cached_url.toString());
                    return m3u8Response;
                } else {
                    return NextResponse.json({ error: 'No channels found' }, { status: 404 });
                }
            } catch (error) {
                return NextResponse.json({ error: 'Failed to parse listChannels' }, { status: 500 });
            }
        }
    }



      // extract live type

  return NextResponse.json({
    cookieGroups: cached_cookie_groups
  });
}