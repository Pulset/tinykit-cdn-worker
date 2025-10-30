/**
 * Cloudflare Worker for TinyKit CDN
 * 用于安全地访问 R2 存储桶中的静态资源
 */

interface Env {
  CDN_BUCKET: R2Bucket;
  ALLOWED_ORIGINS?: string;
  MAX_FILE_SIZE?: string;
}

// 支持的文件类型 MIME 映射
const CONTENT_TYPES: Record<string, string> = {
  // 图片
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',

  // 文档
  '.pdf': 'application/pdf',
  '.json': 'application/json',
  '.xml': 'application/xml',

  // 应用程序
  '.dmg': 'application/x-apple-diskimage',
  '.zip': 'application/zip',
  '.pkg': 'application/x-newton-compatible-pkg',

  // 视频
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',

  // 字体
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
};

// 获取文件的 Content-Type
function getContentType(path: string): string {
  const ext = path.substring(path.lastIndexOf('.')).toLowerCase();
  return CONTENT_TYPES[ext] || 'application/octet-stream';
}

// 验证请求来源（防盗链）
function isOriginAllowed(request: Request, allowedOrigins: string): boolean {
  if (allowedOrigins === '*') return true;

  const origin = request.headers.get('Origin');
  const referer = request.headers.get('Referer');

  if (!origin && !referer) return true; // 直接访问允许

  const allowed = allowedOrigins.split(',').map(o => o.trim());

  if (origin && allowed.some(o => origin.includes(o))) return true;
  if (referer && allowed.some(o => referer.includes(o))) return true;

  return false;
}

// 获取缓存配置和缓存 TTL
function getCacheConfig(path: string): { cacheControl: string; cacheTtl: number } {
  // 根据文件类型设置不同的缓存策略
  if (path.includes('/downloads/')) {
    // 下载文件：短缓存
    return {
      cacheControl: 'public, max-age=3600', // 1小时
      cacheTtl: 3600
    };
  } else if (path.match(/\.(png|jpg|jpeg|gif|webp|svg|ico|woff|woff2|ttf|otf)$/i)) {
    // 静态资源（图片、字体）：长缓存
    return {
      cacheControl: 'public, max-age=31536000, immutable', // 1年
      cacheTtl: 31536000 // 1年
    };
  } else {
    // 其他文件：中等缓存
    return {
      cacheControl: 'public, max-age=86400', // 1天
      cacheTtl: 86400
    };
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // 仅支持 GET 和 HEAD 请求
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    // 健康检查端点
    if (url.pathname === '/health' || url.pathname === '/') {
      return new Response(JSON.stringify({
        status: 'ok',
        service: 'TinyKit CDN',
        timestamp: new Date().toISOString(),
      }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 验证来源（防盗链）
    const allowedOrigins = env.ALLOWED_ORIGINS || '*';
    if (!isOriginAllowed(request, allowedOrigins)) {
      return new Response('Forbidden: Invalid origin', { status: 403 });
    }

    // 获取文件路径（移除开头的 /）
    const key = url.pathname.slice(1);

    if (!key) {
      return new Response('Bad Request: No file path provided', { status: 400 });
    }

    try {
      // 1. 检查 Cloudflare 边缘缓存
      const cache = caches.default;
      const cacheKey = new Request(url.toString(), {
        method: 'GET',
      });

      // 尝试从缓存获取
      let response = await cache.match(cacheKey);

      if (response) {
        console.log(`Cache HIT for: ${key}`);
        // 添加缓存命中标识
        const headers = new Headers(response.headers);
        headers.set('X-Cache-Status', 'HIT');

        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      }

      console.log(`Cache MISS for: ${key}`);

      // 2. 从 R2 获取文件
      const object = await env.CDN_BUCKET.get(key);

      if (!object) {
        return new Response('Not Found', { status: 404 });
      }

      // 检查文件大小（可选）
      const maxSize = parseInt(env.MAX_FILE_SIZE || '0');
      if (maxSize > 0 && object.size > maxSize) {
        return new Response('File Too Large', { status: 413 });
      }

      // 处理条件请求 (304 Not Modified)
      const ifNoneMatch = request.headers.get('If-None-Match');
      const ifModifiedSince = request.headers.get('If-Modified-Since');

      // 检查 ETag 匹配
      if (ifNoneMatch && object.httpEtag && ifNoneMatch === object.httpEtag) {
        const config = getCacheConfig(key);
        return new Response(null, {
          status: 304,
          headers: {
            'ETag': object.httpEtag,
            'Cache-Control': config.cacheControl,
            'Last-Modified': object.uploaded.toUTCString(),
          }
        });
      }

      // 检查修改时间
      if (ifModifiedSince && !ifNoneMatch) {
        const modifiedSince = new Date(ifModifiedSince);
        const lastModified = new Date(object.uploaded);

        // 如果文件未修改（精确到秒）
        if (lastModified.getTime() <= modifiedSince.getTime()) {
          const config = getCacheConfig(key);
          return new Response(null, {
            status: 304,
            headers: {
              'Cache-Control': config.cacheControl,
              'Last-Modified': object.uploaded.toUTCString(),
            }
          });
        }
      }

      // 构建响应头
      const headers = new Headers();

      // Content-Type
      headers.set('Content-Type', object.httpMetadata?.contentType || getContentType(key));

      // 获取缓存配置
      const cacheConfig = getCacheConfig(key);

      // 缓存控制 - 确保可以被 Cloudflare 边缘缓存
      headers.set('Cache-Control', cacheConfig.cacheControl);

      // 添加 CDN-Cache-Control 用于 Cloudflare 边缘缓存
      // 这个头部告诉 Cloudflare 如何缓存，即使客户端有不同的要求
      // 根据 Cloudflare 文档，CDN-Cache-Control 优先于 Cache-Control
      if (key.match(/\.(png|jpg|jpeg|gif|webp|svg|ico|woff|woff2|ttf|otf)$/i)) {
        // 对于静态资源（图片、字体），使用长期缓存
        headers.set('CDN-Cache-Control', 'public, max-age=31536000, immutable');
      } else if (!key.includes('/downloads/')) {
        // 对于其他非下载文件，使用中等缓存
        headers.set('CDN-Cache-Control', 'public, max-age=86400');
      }

      // CORS 支持
      const origin = request.headers.get('Origin');
      if (origin) {
        headers.set('Access-Control-Allow-Origin', allowedOrigins === '*' ? '*' : origin);
        headers.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
        headers.set('Access-Control-Max-Age', '86400');
      }

      // ETag 支持（用于缓存验证）
      if (object.httpEtag) {
        headers.set('ETag', object.httpEtag);
      }

      // 文件元数据
      headers.set('Content-Length', object.size.toString());
      headers.set('Last-Modified', object.uploaded.toUTCString());

      // 安全头
      headers.set('X-Content-Type-Options', 'nosniff');

      // 添加缓存状态标识
      headers.set('X-Cache-Status', 'MISS');

      // 下载文件设置 Content-Disposition
      if (key.includes('/downloads/')) {
        const filename = key.split('/').pop();
        headers.set('Content-Disposition', `attachment; filename="${filename}"`);
      }

      // 处理 HEAD 请求
      if (request.method === 'HEAD') {
        return new Response(null, { headers, status: 200 });
      }

      // 创建响应
      response = new Response(object.body, { headers, status: 200 });

      // 存储到 Cloudflare 边缘缓存
      // 使用 ctx.waitUntil() 确保缓存操作不会阻塞响应
      // 根据 Cloudflare 文档，只有 GET 请求可以被缓存
      ctx.waitUntil(cache.put(cacheKey, response.clone()));

      // 返回文件内容
      return response;

    } catch (error) {
      console.error('Error fetching from R2:', error);
      // 返回更详细的错误信息用于调试
      const errorMessage = error instanceof Error ? error.message : String(error);
      return new Response(`Internal Server Error: ${errorMessage}`, {
        status: 500,
        headers: { 'Content-Type': 'text/plain' }
      });
    }
  },
};
