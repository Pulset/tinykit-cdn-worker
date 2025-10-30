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

// 获取缓存配置
function getCacheControl(path: string): string {
  // 根据文件类型设置不同的缓存策略
  if (path.includes('/downloads/')) {
    // 下载文件：短缓存
    return 'public, max-age=3600'; // 1小时
  } else if (path.match(/\.(png|jpg|jpeg|gif|webp|svg|ico|woff|woff2|ttf|otf)$/i)) {
    // 静态资源：长缓存
    return 'public, max-age=31536000, immutable'; // 1年
  } else {
    // 其他文件：中等缓存
    return 'public, max-age=86400'; // 1天
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
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
      // 从 R2 获取文件
      const object = await env.CDN_BUCKET.get(key);

      if (!object) {
        return new Response('Not Found', { status: 404 });
      }

      // 检查文件大小（可选）
      const maxSize = parseInt(env.MAX_FILE_SIZE || '0');
      if (maxSize > 0 && object.size > maxSize) {
        return new Response('File Too Large', { status: 413 });
      }

      // 构建响应头
      const headers = new Headers();

      // Content-Type
      headers.set('Content-Type', object.httpMetadata?.contentType || getContentType(key));

      // 缓存控制
      headers.set('Cache-Control', getCacheControl(key));

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

      // 下载文件设置 Content-Disposition
      if (key.includes('/downloads/')) {
        const filename = key.split('/').pop();
        headers.set('Content-Disposition', `attachment; filename="${filename}"`);
      }

      // 处理 HEAD 请求
      if (request.method === 'HEAD') {
        return new Response(null, { headers, status: 200 });
      }

      // 返回文件内容
      return new Response(object.body, { headers, status: 200 });

    } catch (error) {
      console.error('Error fetching from R2:', error);
      return new Response('Internal Server Error', { status: 500 });
    }
  },
};
