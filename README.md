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
UPLOAD_SECRET = "your-very-secure-secret-key"  # 上传API密钥，务必使用强密码
UPLOAD_ALLOWED_ORIGINS = "admin.tinykit.app,localhost:3000"  # 允许上传的域名
```

**重要安全提示：**
- `UPLOAD_SECRET` 必须设置为强密码，建议使用32位以上随机字符串
- `UPLOAD_ALLOWED_ORIGINS` 限制只有指定域名可以上传文件
- 生产环境不要使用默认的密钥

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

#### 上传单个文件

```bash
curl -X POST https://cdn.tinykit.app/upload/file-sortify/images/logo.png \
  -H "Authorization: Bearer your-very-secure-secret-key" \
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


### 批量上传脚本

创建一个批量上传脚本 `upload.js`：

```javascript
const fs = require('fs');
const path = require('path');

async function uploadDirectory(localDir, remotePrefix) {
  const files = fs.readdirSync(localDir, { withFileTypes: true });

  for (const file of files) {
    const localPath = path.join(localDir, file.name);
    const remotePath = `${remotePrefix}/${file.name}`;

    if (file.isDirectory()) {
      await uploadDirectory(localPath, remotePath);
    } else {
      const fileContent = fs.readFileSync(localPath);
      const response = await fetch(`https://cdn.tinykit.app/upload/${remotePath}`, {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer your-very-secure-secret-key',
          'Content-Type': 'application/octet-stream'
        },
        body: fileContent
      });

      const result = await response.json();
      console.log(`上传 ${remotePath}:`, result.success ? '成功' : '失败');
    }
  }
}

// 使用示例
uploadDirectory('./assets', 'tinykit-app');
```

### 推荐的目录结构

```
tinykit-assets/
├── file-sortify/
│   ├── images/
│   │   ├── hero-banner.png
│   │   └── screenshots/
│   ├── icons/
│   └── downloads/
│       └── FileSortify-v1.0.dmg
├── app2/
│   └── images/
└── shared/
    └── brand/
```

### 访问文件

部署完成后，通过以下 URL 访问：

```
https://cdn.tinykit.app/file-sortify/images/logo.png
https://cdn.tinykit.app/file-sortify/downloads/FileSortify-v1.0.dmg
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
1. **密钥验证**：所有上传请求需要有效的 `UPLOAD_SECRET`
2. **来源限制**：通过 `UPLOAD_ALLOWED_ORIGINS` 限制上传来源
3. **路径验证**：防止路径遍历攻击（禁止 `../` 等）
4. **文件类型限制**：只允许预定义的文件扩展名
5. **大小检查**：上传前和上传后都检查文件大小

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
