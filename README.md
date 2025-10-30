# TinyKit CDN Worker

Cloudflare Worker 用于安全地访问 R2 存储桶中的静态资源。

## 功能特性

✅ **安全访问控制**

- 防盗链保护（Origin/Referer 验证）
- 可配置的访问白名单
- 文件大小限制

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

✅ **下载支持**

- 自动设置 Content-Disposition
- 支持大文件下载

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
```

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

### 上传文件到 R2

推荐的目录结构：

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

使用 wrangler 上传：

```bash
# 上传单个文件
npx wrangler r2 object put tinykit-assets/file-sortify/images/hero.png --file ./hero.png

# 上传目录（需要脚本）
# 或使用 Cloudflare Dashboard 上传
```

### 访问文件

部署完成后，通过以下 URL 访问：

```
https://cdn.tinykit.app/file-sortify/images/hero-banner.png
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

1. **防盗链**：通过 `ALLOWED_ORIGINS` 限制访问来源
2. **文件大小限制**：通过 `MAX_FILE_SIZE` 防止超大文件访问
3. **CORS 支持**：自动处理跨域请求
4. **安全头**：自动添加 `X-Content-Type-Options: nosniff`

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
curl -X PURGE https://cdn.tinykit.app/file-sortify/images/hero.png
```

## 相关链接

- [Cloudflare R2 文档](https://developers.cloudflare.com/r2/)
- [Cloudflare Workers 文档](https://developers.cloudflare.com/workers/)
- [Wrangler CLI 文档](https://developers.cloudflare.com/workers/wrangler/)
