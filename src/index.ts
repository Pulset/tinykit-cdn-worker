/**
 * Cloudflare Worker for TinyKit CDN
 * 用于安全地访问 R2 存储桶中的静态资源
 */

interface Env {
  CDN_BUCKET: R2Bucket;
  ALLOWED_ORIGINS?: string;
  MAX_FILE_SIZE?: string;
  UPLOAD_ALLOWED_ORIGINS?: string; // 允许上传的来源域名
  JWT_SECRETS?: string; // 多应用JWT密钥映射，JSON格式: {"app1": "secret1", "app2": "secret2"}
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

  const allowed = allowedOrigins.split(',').map((o) => o.trim());

  if (origin && allowed.some((o) => origin.includes(o))) return true;
  if (referer && allowed.some((o) => referer.includes(o))) return true;

  return false;
}

// 获取缓存配置和缓存 TTL
function getCacheConfig(path: string): {
  cacheControl: string;
  cacheTtl: number;
} {
  // 根据文件类型设置不同的缓存策略
  if (path.includes('/downloads/')) {
    // 下载文件：短缓存
    return {
      cacheControl: 'public, max-age=3600', // 1小时
      cacheTtl: 3600,
    };
  } else if (
    path.match(/\.(png|jpg|jpeg|gif|webp|svg|ico|woff|woff2|ttf|otf)$/i)
  ) {
    // 静态资源（图片、字体）：长缓存
    return {
      cacheControl: 'public, max-age=31536000, immutable', // 1年
      cacheTtl: 31536000, // 1年
    };
  } else {
    // 其他文件：中等缓存
    return {
      cacheControl: 'public, max-age=86400', // 1天
      cacheTtl: 86400,
    };
  }
}

// JWT解密函数（使用Web Crypto API）
async function parseJWTToken(
  token: string,
  secrets: { [key: string]: string }
): Promise<{ valid: boolean; payload?: any; error?: string }> {
  // 输入验证
  if (!token || typeof token !== 'string') {
    return { valid: false, error: 'Invalid token format' };
  }

  if (!secrets || typeof secrets !== 'object') {
    return { valid: false, error: 'Invalid secrets configuration' };
  }

  try {
    const parts = token.split('.');

    // 必须是JWT格式（header.payload.signature）
    if (parts.length !== 3) {
      return { valid: false, error: 'Token must be in JWT format' };
    }

    // 安全的Base64解码函数
    const safeBase64Decode = (str: string): any => {
      try {
        // 补齐padding
        const padded = str + '='.repeat((4 - (str.length % 4)) % 4);
        return JSON.parse(atob(padded));
      } catch (error) {
        throw new Error('Invalid Base64 encoding');
      }
    };

    // 解析Payload获取appName
    const payload = safeBase64Decode(parts[1]);

    // 验证应用名称
    if (!payload.appName || typeof payload.appName !== 'string') {
      return { valid: false, error: 'JWT payload must contain valid appName' };
    }

    if (!secrets[payload.appName]) {
      return {
        valid: false,
        error: `No JWT secret configured for app: ${payload.appName}`,
      };
    }

    const appSecret = secrets[payload.appName];
    if (!appSecret || typeof appSecret !== 'string') {
      return {
        valid: false,
        error: `Invalid secret configured for app: ${payload.appName}`,
      };
    }

    // 验证过期时间
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && typeof payload.exp === 'number') {
      if (payload.exp < now) {
        return { valid: false, error: 'Token expired' };
      }
      // 可选：检查过期时间是否合理（不超过1年）
      const maxExp = now + 365 * 24 * 60 * 60;
      if (payload.exp > maxExp) {
        return { valid: false, error: 'Token expiration too far in future' };
      }
    } else {
      return {
        valid: false,
        error: 'JWT payload must contain exp (expiration time)',
      };
    }

    // 解析header
    const header = safeBase64Decode(parts[0]);

    // 验证JWT格式
    if (header.typ !== 'JWT' || header.alg !== 'HS256') {
      return {
        valid: false,
        error: 'Invalid JWT format or algorithm (only HS256 supported)',
      };
    }

    // 使用Web Crypto API进行HMAC验证
    const keyData = new TextEncoder().encode(appSecret);
    const data = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);

    const key = await crypto.subtle.importKey(
      'raw',
      keyData,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );

    // 安全的Base64解码签名
    let signatureArray: Uint8Array;
    try {
      const signature = parts[2].replace(/-/g, '+').replace(/_/g, '/');
      const padded = signature + '='.repeat((4 - (signature.length % 4)) % 4);
      const binaryString = atob(padded);
      signatureArray = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        signatureArray[i] = binaryString.charCodeAt(i);
      }
    } catch (error) {
      return { valid: false, error: 'Invalid signature encoding' };
    }

    const isValid = await crypto.subtle.verify(
      'HMAC',
      key,
      signatureArray,
      data
    );

    if (!isValid) {
      return { valid: false, error: 'Invalid JWT signature' };
    }

    return { valid: true, payload };
  } catch (error) {
    console.error('JWT parsing error:', error);
    return { valid: false, error: 'Failed to parse JWT token' };
  }
}

// 验证上传请求的安全性（仅支持JWT Token）
async function validateUploadRequest(
  request: Request,
  env: Env,
  key: string
): Promise<{ valid: boolean; error?: string; tokenData?: any }> {
  // 验证请求来源（如果配置了允许的来源）
  if (env.UPLOAD_ALLOWED_ORIGINS) {
    const origin = request.headers.get('Origin');
    const referer = request.headers.get('Referer');

    if (!origin && !referer) {
      return { valid: false, error: 'Origin verification failed' };
    }

    const allowed = env.UPLOAD_ALLOWED_ORIGINS.split(',').map((o) => o.trim());
    const isAllowed =
      (origin && allowed.some((o) => origin.includes(o))) ||
      (referer && allowed.some((o) => referer.includes(o)));

    if (!isAllowed) {
      return { valid: false, error: 'Origin not allowed for uploads' };
    }
  }

  // 检查临时token
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { valid: false, error: 'Missing or invalid authorization header' };
  }

  const token = authHeader.substring(7);

  // 解析多应用JWT密钥配置（必须配置）
  let jwtSecrets: { [key: string]: string };
  if (env.JWT_SECRETS) {
    try {
      jwtSecrets = JSON.parse(env.JWT_SECRETS);
    } catch (error) {
      console.error('Failed to parse JWT_SECRETS:', error);
      return { valid: false, error: 'Invalid JWT_SECRETS configuration' };
    }
  } else {
    return { valid: false, error: 'JWT_SECRETS must be configured' };
  }

  // 验证JWT Token（必须格式）
  const tokenResult = await parseJWTToken(token, jwtSecrets);
  if (!tokenResult.valid) {
    return { valid: false, error: tokenResult.error || 'Invalid JWT token' };
  }

  const tokenData = tokenResult.payload;
  const now = Math.floor(Date.now() / 1000);

  // 检查过期时间
  if (tokenData.exp && tokenData.exp < now) {
    return { valid: false, error: 'Token expired' };
  }

  // 验证路径权限
  if (tokenData.allowedPaths && !tokenData.allowedPaths.includes('*')) {
    const pathAllowed = tokenData.allowedPaths.some((pattern: string) => {
      if (pattern === '*') return true;
      if (pattern.endsWith('/*')) {
        return key.startsWith(pattern.slice(0, -1));
      }
      return key === pattern;
    });

    if (!pathAllowed) {
      return { valid: false, error: `Path not allowed for token: ${key}` };
    }
  }

  return { valid: true, tokenData };
}

// 验证文件路径安全性
function validateFilePath(key: string): { valid: boolean; error?: string } {
  // 禁止路径遍历攻击
  if (key.includes('..') || key.includes('//') || key.startsWith('/')) {
    return { valid: false, error: 'Invalid file path' };
  }

  // 检查文件扩展名是否在允许列表中
  const allowedExtensions = Object.keys(CONTENT_TYPES);
  const ext = key.substring(key.lastIndexOf('.')).toLowerCase();

  if (!allowedExtensions.includes(ext)) {
    return { valid: false, error: 'File type not allowed' };
  }

  // 限制路径长度
  if (key.length > 500) {
    return { valid: false, error: 'File path too long' };
  }

  return { valid: true };
}

// 处理文件上传请求
async function handleUpload(request: Request, env: Env): Promise<Response> {
  try {
    const url = new URL(request.url);
    const key = url.pathname.slice(9); // 移除 "/upload/" 前缀

    // 验证上传请求安全性
    const validation = await validateUploadRequest(request, env, key);
    if (!validation.valid) {
      return new Response(
        JSON.stringify({
          error: validation.error,
          code: 'UNAUTHORIZED',
        }),
        {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    // 验证文件路径
    const pathValidation = validateFilePath(key);
    if (!pathValidation.valid) {
      return new Response(
        JSON.stringify({
          error: pathValidation.error,
          code: 'INVALID_PATH',
        }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    // 获取文件大小限制（优先使用token中的限制）
    let maxSize = parseInt(env.MAX_FILE_SIZE || '104857600'); // 默认100MB
    if (validation.tokenData && validation.tokenData.maxFileSize) {
      maxSize = Math.min(maxSize, validation.tokenData.maxFileSize);
    }

    // 检查文件大小限制
    const contentLength = request.headers.get('Content-Length');
    if (contentLength && parseInt(contentLength) > maxSize) {
      return new Response(
        JSON.stringify({
          error: `File too large. Maximum size: ${maxSize} bytes`,
          code: 'FILE_TOO_LARGE',
        }),
        {
          status: 413,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    // 读取文件数据
    const fileData = await request.arrayBuffer();

    // 再次检查文件大小
    if (fileData.byteLength > maxSize) {
      return new Response(
        JSON.stringify({
          error: `File too large. Maximum size: ${maxSize} bytes`,
          code: 'FILE_TOO_LARGE',
        }),
        {
          status: 413,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    // 检测文件MIME类型
    const detectedContentType = getContentType(key);

    // 验证文件扩展名（如果有token限制）
    if (validation.tokenData && validation.tokenData.allowedExtensions) {
      const fileExt = key.substring(key.lastIndexOf('.')).toLowerCase();
      if (!validation.tokenData.allowedExtensions.includes(fileExt)) {
        return new Response(
          JSON.stringify({
            error: `File extension not allowed: ${fileExt}. Allowed: ${validation.tokenData.allowedExtensions.join(
              ', '
            )}`,
            code: 'EXTENSION_NOT_ALLOWED',
          }),
          {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }
    }

    // 上传到R2
    await env.CDN_BUCKET.put(key, fileData, {
      httpMetadata: {
        contentType: detectedContentType,
      },
    });

    // 返回成功响应
    return new Response(
      JSON.stringify({
        success: true,
        message: 'File uploaded successfully',
        data: {
          key: key,
          size: fileData.byteLength,
          contentType: detectedContentType,
          url: `${url.origin}/${key}`,
          timestamp: new Date().toISOString(),
          // 如果使用了临时token，返回相关信息
          app: validation.tokenData?.appName || 'unknown',
        },
      }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      }
    );
  } catch (error) {
    console.error('Upload error:', error);
    return new Response(
      JSON.stringify({
        error: 'Upload failed',
        message: error instanceof Error ? error.message : 'Unknown error',
        code: 'UPLOAD_ERROR',
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);

    // 处理 CORS 预检请求
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 200,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    // 处理文件上传请求
    if (request.method === 'POST' && url.pathname.startsWith('/upload/')) {
      return handleUpload(request, env);
    }

    // 仅支持 GET 和 HEAD 请求用于文件访问
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    // 健康检查端点
    if (url.pathname === '/health' || url.pathname === '/') {
      return new Response(
        JSON.stringify({
          status: 'ok',
          service: 'TinyKit CDN',
          timestamp: new Date().toISOString(),
        }),
        {
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    // 验证来源（防盗链）
    const allowedOrigins = env.ALLOWED_ORIGINS || '*';
    if (!isOriginAllowed(request, allowedOrigins)) {
      return new Response('Forbidden: Invalid origin', { status: 403 });
    }

    // 获取文件路径（移除开头的 /）
    const key = url.pathname.slice(1);

    if (!key) {
      return new Response('Bad Request: No file path provided', {
        status: 400,
      });
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
            ETag: object.httpEtag,
            'Cache-Control': config.cacheControl,
            'Last-Modified': object.uploaded.toUTCString(),
          },
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
            },
          });
        }
      }

      // 构建响应头
      const headers = new Headers();

      // Content-Type
      headers.set(
        'Content-Type',
        object.httpMetadata?.contentType || getContentType(key)
      );

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
        headers.set(
          'Access-Control-Allow-Origin',
          allowedOrigins === '*' ? '*' : origin
        );
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
        headers.set(
          'Content-Disposition',
          `attachment; filename="${filename}"`
        );
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
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      return new Response(`Internal Server Error: ${errorMessage}`, {
        status: 500,
        headers: { 'Content-Type': 'text/plain' },
      });
    }
  },
};
