# TinyKit CDN Worker

Cloudflare Worker 用于安全地访问和上传 R2 存储桶中的静态资源。

## 功能特性

✅ **安全访问控制**

- 防盗链保护（Origin/Referer 验证）
- 可配置的访问白名单
- 文件大小限制
- 上传API密钥验证

✅ **文件管理**

- 安全的文件上传API
- 自动MIME类型检测
- 支持多种文件格式

✅ **性能优化**

- 智能缓存策略（根据文件类型自动配置）
- ETag 支持
- CDN 边缘缓存
- **零 egress 费用**（通过 Worker 访问 R2）

✅ **完整的 MIME 类型支持**

- 图片格式（PNG, JPG, WebP, SVG 等）
- 应用程序（DMG, PKG, ZIP）
- 文档（PDF, JSON）
- 字体文件
- 视频格式（MP4, WebM）

✅ **下载支持**

- 自动设置 Content-Disposition
- 支持大文件下载
- 条件请求支持（304 Not Modified）

## 部署步骤

### 1. 安装依赖

```bash
cd cloudflare-worker
npm install
```

### 2. 创建 R2 存储桶

在 Cloudflare Dashboard 中：

1. 进入 **R2** 服务
2. 创建新的存储桶，命名为 `tinykit`（或其他名称）
3. 记录存储桶名称

### 3. 配置 Worker

编辑 `wrangler.toml`：

```toml
[[r2_buckets]]
binding = "CDN_BUCKET"
bucket_name = "tinykit"  # 替换为你实际的 bucket 名称

[vars]
ALLOWED_ORIGINS = "tinykit.app,*.tinykit.app"  # 生产环境设置具体域名
MAX_FILE_SIZE = "104857600"  # 100MB，根据需要调整
UPLOAD_ALLOWED_ORIGINS = "admin.tinykit.app,localhost:3000"  # 允许上传的域名
JWT_SECRETS = '{"file-sortify": "secret1", "video-app": "secret2", "docs-app": "secret3"}'  # 多应用JWT密钥映射，JSON格式
```

**安全提示：**
- `UPLOAD_ALLOWED_ORIGINS` 限制只有指定域名可以上传文件
- 上传文件**必须使用JWT Token**（不支持其他格式）
- `JWT_SECRETS`用于多应用专属JWT密钥映射（必配）
- 每个JWT Token必须包含应用名称(`appName`)用于密钥匹配
- 本CDN Worker不提供Token生成服务，请在外部系统生成Token

#### 多应用密钥配置

CDN Worker使用 `JWT_SECRETS` 环境变量配置每个应用的专属密钥：

```toml
JWT_SECRETS = '{"file-sortify": "app-secret-1", "video-app": "app-secret-2", "docs-app": "app-secret-3"}'
```

**配置说明：**
- JSON格式，键为应用名称，值为对应的JWT密钥
- 每个应用必须配置专属密钥才能使用JWT Token
- 建议为不同应用使用不同的强密钥（至少32位）
- 支持动态添加新应用，无需重新部署
- 只支持HS256算法的JWT Token

### 4. 登录 Cloudflare

```bash
npx wrangler login
```

### 5. 本地开发测试

```bash
npm run dev
```

访问 `http://localhost:8787/health` 测试是否正常运行。

### 6. 部署到生产环境

```bash
npm run deploy
```

部署成功后会显示 Worker URL，例如：

```
https://tinykit.your-account.workers.dev
```

### 7. 绑定自定义域名

在 Cloudflare Dashboard 中：

1. 进入 **Workers & Pages** → 选择你的 Worker
2. 点击 **Settings** → **Triggers**
3. 在 **Custom Domains** 中添加 `cdn.tinykit.app`
4. 保存配置（自动配置 DNS）

## 使用示例

### API 文件上传

#### 🔒 安全架构
本CDN Worker**仅支持临时Token认证**，不提供Token生成服务。你需要在外部系统（如管理后台、CI/CD等）生成Token。

#### JWT Token格式

CDN Worker仅支持标准JWT格式，包含Header、Payload和Signature：

```json
// JWT Header（必填）
{
  "typ": "JWT",
  "alg": "HS256"
}

// JWT Payload（必填）
{
  "exp": 1737870747,                    // 过期时间（Unix时间戳，必填）
  "allowedPaths": ["app-name/*"],       // 允许的路径（必填）
  "appName": "app-name",                // 应用名称（必填，用于密钥匹配）
  "maxFileSize": 52428800,              // 最大文件大小（可选）
  "allowedExtensions": [".png", ".jpg"], // 允许的文件扩展名（可选）
  "created": "2025-01-25T12:59:07.000Z"  // 创建时间（可选）
}
```

**JWT Token要求：**
- 必须使用HS256算法签名
- Payload必须包含`appName`字段
- 必须包含`exp`过期时间
- 必须包含`allowedPaths`权限配置

> **重要说明：** CDN Worker 使用原生的 Web Crypto API 进行 JWT 验证，无需安装任何依赖库。这使得 Worker 运行更高效、更安全。JWT Token 的生成在外部系统（如后端服务、CI/CD脚本等）中完成。

#### 生成Token示例（外部系统）

```javascript
// 在外部系统中生成JWT Token（如Node.js后端）
// 需要安装jsonwebtoken库: npm install jsonwebtoken
const jwt = require('jsonwebtoken');

// 应用密钥配置
const APP_SECRETS = {
  'file-sortify': 'app-secret-1',
  'video-app': 'app-secret-2',
  'docs-app': 'app-secret-3'
};

function generateJWTUploadToken(appName, allowedPaths, maxAge = 3600, maxFileSize, allowedExtensions) {
  const payload = {
    exp: Math.floor(Date.now() / 1000) + maxAge,
    allowedPaths,
    appName,
    created: new Date().toISOString(),
    ...(maxFileSize && { maxFileSize }),
    ...(allowedExtensions && { allowedExtensions })
  };

  // 使用应用专属密钥签名
  const appSecret = APP_SECRETS[appName] || 'default-secret';
  return jwt.sign(payload, appSecret, { algorithm: 'HS256' });
}

// 为File Sortify生成JWT Token
const fileSortifyToken = generateJWTUploadToken(
  'file-sortify',
  ['file-sortify/*'],
  3600, // 1小时有效期
  52428800, // 50MB文件大小限制
  ['.png', '.jpg', '.jpeg', '.svg', '.ico']
);

// 为Video App生成JWT Token（使用不同密钥）
const videoAppToken = generateJWTUploadToken(
  'video-app',
  ['video-app/*'],
  7200, // 2小时有效期
  209715200, // 200MB文件大小限制
  ['.mp4', '.webm', '.jpg', '.png']
);
```

#### 使用Token上传文件

```bash
# 使用JWT Token上传文件
curl -X POST https://cdn.tinykit.app/upload/file-sortify/images/logo.png \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJleHAiOjE3Mzc4NzA3NDcsImFsbG93ZWRQYXRocyI6WyJmaWxlLXNvcnRpZnkvKiJdLCJhcHBOYW1lIjoiZmlsZS1zb3J0aWZ5IiwiY3JlYXRlZCI6IjIwMjUtMDEtMjVUMTI6NTk6MDcuMDAwWiJ9.signature" \
  -H "Content-Type: image/png" \
  --data-binary @./logo.png
```

#### JavaScript上传示例

```javascript
async function uploadFile(file, targetPath, token) {
  const response = await fetch(`https://cdn.tinykit.app/upload/${targetPath}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': file.type
    },
    body: file
  });

  const result = await response.json();
  if (!result.success) {
    throw new Error(`上传失败: ${result.error}`);
  }
  return result;
}

// 使用示例
const file = document.getElementById('fileInput').files[0];
const token = '从你的后端获取的JWT Token'; // 必须从安全的后端获取
const result = await uploadFile(file, 'file-sortify/images/logo.png', token);
console.log('上传成功:', result);
```

#### 推荐的架构模式

**方案1：管理后台生成Token**

```javascript
// 在你的管理后台中生成Token
app.post('/admin/generate-upload-token', async (req, res) => {
  // 验证管理员身份
  if (!req.session.isAdmin) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { appName, maxAge = 3600 } = req.body;

  // 生成Token
  const tokenData = {
    exp: Math.floor(Date.now() / 1000) + maxAge,
    allowedPaths: [`${appName}/*`],
    appName,
    created: new Date().toISOString(),
    maxFileSize: getAppMaxFileSize(appName),
    allowedExtensions: getAppAllowedExtensions(appName)
  };

  const token = Buffer.from(JSON.stringify(tokenData)).toString('base64');
  res.json({ token, expiresIn: maxAge });
});
```

**方案2：CI/CD集成**

```bash
#!/bin/bash
# deploy.sh - CI/CD脚本中的JWT Token生成

generate_jwt_token() {
  local app_name=$1
  local max_age=${2:-3600}
  local app_secret=""

  # 根据app名称选择密钥
  case $app_name in
    "file-sortify")
      app_secret="app-secret-1"
      ;;
    "video-app")
      app_secret="app-secret-2"
      ;;
    "docs-app")
      app_secret="app-secret-3"
      ;;
    *)
      app_secret="default-secret"
      ;;
  esac

  # 注意：这里需要安装jsonwebtoken库: npm install jsonwebtoken
  node -e "
    const jwt = require('jsonwebtoken');
    const payload = {
      exp: Math.floor(Date.now() / 1000) + $max_age,
      allowedPaths: ['$app_name/*'],
      appName: '$app_name',
      created: new Date().toISOString(),
      maxFileSize: 52428800,
      allowedExtensions: ['.png', '.jpg', '.jpeg', '.svg', '.ico']
    };
    console.log(jwt.sign(payload, '$app_secret', { algorithm: 'HS256' }));
  "
}

# 使用示例
JWT_TOKEN=$(generate_jwt_token "file-sortify" 3600)
curl -X POST https://cdn.tinykit.app/upload/file-sortify/images/logo.png \
  -H "Authorization: Bearer $JWT_TOKEN" \
  -H "Content-Type: image/png" \
  --data-binary @./logo.png
```

**响应示例：**
```json
{
  "success": true,
  "message": "File uploaded successfully",
  "data": {
    "key": "file-sortify/images/logo.png",
    "size": 12345,
    "contentType": "image/png",
    "url": "https://cdn.tinykit.app/file-sortify/images/logo.png",
    "timestamp": "2025-01-20T12:00:00.000Z"
  }
}
```

#### JavaScript 上传示例

```javascript
async function uploadFile(file, targetPath) {
  const response = await fetch(`https://cdn.tinykit.app/upload/${targetPath}`, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer your-very-secure-secret-key',
      'Content-Type': file.type
    },
    body: file
  });

  const result = await response.json();
  return result;
}

// 使用示例
const fileInput = document.getElementById('file');
const file = fileInput.files[0];
const result = await uploadFile(file, 'file-sortify/images/new-logo.png');
console.log('上传结果:', result);
```


### 批量上传脚本（多应用版）

创建一个批量上传脚本 `upload.js`：

```javascript
const fs = require('fs');
const path = require('path');
// 在外部系统中生成JWT Token需要安装jsonwebtoken库
// npm install jsonwebtoken
const jwt = require('jsonwebtoken');

// 应用密钥配置
const APP_SECRETS = {
  'file-sortify': 'app-secret-1',
  'video-app': 'app-secret-2',
  'docs-app': 'app-secret-3'
};

// 生成应用专用的JWT Token
function generateAppToken(appName, allowedPaths, maxFileSize, allowedExtensions, maxAge = 3600) {
  const tokenData = {
    exp: Math.floor(Date.now() / 1000) + maxAge,
    allowedPaths,
    appName,
    created: new Date().toISOString(),
    maxFileSize,
    allowedExtensions
  };

  // 使用应用专属密钥生成JWT Token
  return jwt.sign(tokenData, APP_SECRETS[appName], { algorithm: 'HS256' });
}

async function uploadDirectory(localDir, remotePrefix, token) {
  const files = fs.readdirSync(localDir, { withFileTypes: true });

  for (const file of files) {
    const localPath = path.join(localDir, file.name);
    const remotePath = `${remotePrefix}/${file.name}`;

    if (file.isDirectory()) {
      await uploadDirectory(localPath, remotePath, token);
    } else {
      const fileContent = fs.readFileSync(localPath);
      const response = await fetch(`https://cdn.tinykit.app/upload/${remotePath}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/octet-stream'
        },
        body: fileContent
      });

      const result = await response.json();
      console.log(`上传 ${remotePath}:`, result.success ? '✅ 成功' : `❌ 失败 - ${result.error}`);
    }
  }
}

// 使用示例 - 不同应用使用不同的配置
async function uploadApps() {
  // App1: File Sortify - 图片和图标
  const fileSortifyToken = generateAppToken(
    'file-sortify',
    ['file-sortify/*'],
    50 * 1024 * 1024, // 50MB
    ['.png', '.jpg', '.jpeg', '.svg', '.ico']
  );
  await uploadDirectory('./apps/file-sortify/assets', 'file-sortify/assets', fileSortifyToken);

  // App2: Video App - 视频和缩略图
  const videoAppToken = generateAppToken(
    'video-app',
    ['video-app/*'],
    200 * 1024 * 1024, // 200MB
    ['.mp4', '.webm', '.jpg', '.png']
  );
  await uploadDirectory('./apps/video-app/content', 'video-app/content', videoAppToken);

  // App3: Documentation - 文档文件
  const docsAppToken = generateAppToken(
    'docs-app',
    ['docs/*'],
    10 * 1024 * 1024, // 10MB
    ['.pdf', '.json', '.md']
  );
  await uploadDirectory('./apps/docs', 'docs', docsAppToken);
}

uploadApps();
```

### 推荐的多应用目录结构

```
tinykit-assets/
├── file-sortify/                    # File Sortify 应用
│   ├── images/
│   │   ├── hero-banner.png
│   │   └── screenshots/
│   ├── icons/
│   └── downloads/
│       └── FileSortify-v1.0.dmg
├── video-app/                       # 视频应用
│   ├── thumbnails/
│   ├── trailers/
│   └── backgrounds/
├── docs-app/                        # 文档应用
│   ├── user-guide/
│   ├── api-docs/
│   └── tutorials/
├── admin-panel/                     # 管理面板
│   ├── assets/
│   └── reports/
└── shared/                          # 共享资源
    ├── brand/
    └── common/
```

### 访问文件

部署完成后，通过以下 URL 访问各应用的资源：

```bash
# File Sortify 应用资源
https://cdn.tinykit.app/file-sortify/images/logo.png
https://cdn.tinykit.app/file-sortify/downloads/FileSortify-v1.0.dmg

# Video App 资源
https://cdn.tinykit.app/video-app/trailers/demo.mp4
https://cdn.tinykit.app/video-app/thumbnails/thumb.jpg

# 文档应用资源
https://cdn.tinykit.app/docs-app/user-guide/intro.pdf
https://cdn.tinykit.app/docs-app/api-docs/reference.json

# 管理面板资源
https://cdn.tinykit.app/admin-panel/assets/dashboard.css

# 共享资源
https://cdn.tinykit.app/shared/brand/logo.svg
https://cdn.tinykit.app/shared/common/default-avatar.png
```

### 健康检查

```bash
curl https://cdn.tinykit.app/health
```

返回：

```json
{
  "status": "ok",
  "service": "TinyKit CDN",
  "timestamp": "2025-01-20T12:00:00.000Z"
}
```

## 缓存策略

Worker 会根据文件类型自动设置缓存：

| 文件类型   | 缓存时间 | 说明                        |
| ---------- | -------- | --------------------------- |
| 图片、字体 | 1 年     | 长期缓存，带 immutable 标记 |
| 下载文件   | 1 小时   | 短缓存，便于更新            |
| 其他文件   | 1 天     | 中等缓存                    |

## 安全特性

### 访问安全
1. **防盗链**：通过 `ALLOWED_ORIGINS` 限制访问来源
2. **文件大小限制**：通过 `MAX_FILE_SIZE` 防止超大文件访问
3. **CORS 支持**：自动处理跨域请求
4. **安全头**：自动添加 `X-Content-Type-Options: nosniff`

### 上传安全

#### 🔒 密钥安全原则
- **永久密钥只能用于后端服务**，绝不能暴露给前端
- **使用临时Token** 进行前端上传认证
- **实施最小权限原则**，限制上传路径和文件类型

#### 🛡️ 安全机制
1. **临时Token认证**：仅支持临时Token上传，管理员密钥不用于文件上传
2. **来源限制**：通过 `UPLOAD_ALLOWED_ORIGINS` 限制上传域名
3. **路径验证**：防止路径遍历攻击（禁止 `../` 等）
4. **文件类型限制**：只允许预定义的文件扩展名
5. **大小检查**：上传前和上传后都检查文件大小
6. **Token过期**：临时Token具有时效性，降低泄露风险
7. **应用隔离**：每个Token只能访问指定的路径和文件类型

#### 🚫 禁止的做法
```javascript
// ❌ 错误：试图直接使用管理员密钥上传
fetch('/upload/file.png', {
  headers: {
    'Authorization': `Bearer ${ADMIN_SECRET}` // 不再支持！
  }
});

// ❌ 错误：在前端存储管理员密钥
const ADMIN_SECRET = 'your-admin-secret'; // 危险！

// ❌ 错误：在前端生成Token
fetch('/generate-upload-token', {
  headers: {
    'Authorization': `Bearer ${ADMIN_SECRET}` // 只能在后端使用！
  }
});
```

#### ✅ 正确的做法
```javascript
// ✅ 正确：使用临时Token上传
const tempToken = '从后端获取的临时Token'; // 安全的做法

fetch('/upload/app/images/logo.png', {
  headers: {
    'Authorization': `Bearer ${tempToken}`
  },
  body: fileData
});
```

## 监控和日志

查看实时日志：

```bash
npm run tail
```

在 Cloudflare Dashboard 查看：

- 请求统计
- 错误率
- 延迟数据
- 带宽使用

## 成本说明

### R2 费用（通过 Worker 访问）

- ✅ **Class A 操作**（写入）：免费额度 100 万次/月
- ✅ **Class B 操作**（读取）：免费额度 1000 万次/月
- ✅ **存储**：$0.015/GB/月
- ✅ **Egress**：**完全免费**（这是最大优势！）

### Worker 费用

- ✅ **请求**：免费额度 10 万次/天
- 超出后：$0.50/百万次请求

对比直接使用 R2.dev 公开访问，通过 Worker 可以节省大量 egress 费用。

## 故障排查

### 404 Not Found

- 检查文件路径是否正确
- 确认文件已上传到 R2
- 验证 bucket 绑定配置

### 403 Forbidden

- 检查 `ALLOWED_ORIGINS` 配置
- 确认请求来源是否在白名单中

### 500 Internal Server Error

- 查看 Worker 日志：`npm run tail`
- 检查 R2 bucket 绑定是否正确

## API 错误代码

| 错误代码 | HTTP状态码 | 描述 | 解决方案 |
|---------|-----------|------|---------|
| UNAUTHORIZED | 401 | 无效的上传密钥或来源 | 检查 `Authorization` 头部和域名配置 |
| INVALID_PATH | 400 | 无效的文件路径 | 避免使用 `../` 或绝对路径 |
| FILE_TOO_LARGE | 413 | 文件超出大小限制 | 检查 `MAX_FILE_SIZE` 配置 |
| UPLOAD_ERROR | 500 | 上传失败 | 检查 R2 配置和网络连接 |

## 进阶配置

### 图片实时处理

可以集成 Cloudflare Images 或在 Worker 中添加图片处理逻辑：

```typescript
// 示例：添加图片尺寸参数
// https://cdn.tinykit.app/app/image.png?w=800&q=80
```

### 访问统计

可以在 Worker 中添加访问统计逻辑，记录到 D1 数据库或 Analytics Engine。

### CDN 缓存清除

```bash
# 清除特定文件缓存
curl -X PURGE https://cdn.tinykit.app/file-sortify/images/logo.png
```

### 管理后台集成

可以基于上传API构建一个简单的管理后台：

```javascript
// 管理后台示例代码
const API_BASE = 'https://cdn.tinykit.app';
const API_SECRET = 'your-very-secure-secret-key';

class CDNManager {
  async uploadFile(file, path) {
    const formData = new FormData();
    formData.append('file', file);

    const response = await fetch(`${API_BASE}/upload/${path}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_SECRET}`
      },
      body: file
    });

    return response.json();
  }

  async listFiles(prefix = '') {
    // 可以扩展一个列表API
    // 需要在Worker中添加对应的处理逻辑
  }
}
```

## 性能优化建议

1. **压缩上传**：对于大文件，可以在客户端先压缩
2. **分片上传**：支持超大文件的分片上传和断点续传
3. **CDN预热**：重要文件可以提前预热到CDN边缘节点
4. **批量操作**：减少API调用次数，提高效率

## 相关链接

- [Cloudflare R2 文档](https://developers.cloudflare.com/r2/)
- [Cloudflare Workers 文档](https://developers.cloudflare.com/workers/)
- [Wrangler CLI 文档](https://developers.cloudflare.com/workers/wrangler/)
- [Fetch API 文档](https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API)
