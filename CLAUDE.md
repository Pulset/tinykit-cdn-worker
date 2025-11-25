# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a Cloudflare Worker CDN service that provides secure access to R2 storage bucket static resources. It acts as a CDN proxy with security features, caching strategies, and zero egress costs through Worker access to R2.

## Architecture

The entire codebase consists of a single Cloudflare Worker entry point (`src/index.ts`) that:

1. **Security Layer**: Implements origin/referer validation for hotlink protection
2. **Cache Layer**: Multi-tier caching with Cloudflare edge cache and R2 object storage
3. **Content Delivery**: MIME type detection and appropriate response headers
4. **Access Control**: File size limits and configurable allowed origins

The Worker is configured via `wrangler.toml` with R2 bucket bindings and environment variables.

## Common Commands

### Development
```bash
# Start local development server
npm run dev

# Deploy to production
npm run deploy

# View real-time logs
npm run tail

# Install dependencies
npm install
```

### R2 Operations
```bash
# Upload single file to R2
npx wrangler r2 object put cdn.tinykit.app/file-sortify/images/logo.png --file ./logo.png

# List objects in bucket
npx wrangler r2 object list tinykit

# Download object from R2
npx wrangler r2 object get tinykit/file-sortify/images/logo.png
```

### Configuration
- `wrangler.toml`: Main configuration including R2 bucket bindings, environment variables
- Environment variables: `ALLOWED_ORIGINS`, `MAX_FILE_SIZE`
- TypeScript target: ES2021 with Cloudflare Workers types

## Key Features

### Caching Strategy
- **Static assets** (images, fonts): 1 year cache with `immutable` flag
- **Download files**: 1 hour cache for frequent updates
- **Other files**: 1 day medium cache
- Uses both `Cache-Control` and `CDN-Cache-Control` headers for optimal Cloudflare caching

### Security Controls
- Origin/referer validation via `ALLOWED_ORIGINS` whitelist
- File size limits via `MAX_FILE_SIZE`
- CORS support with configurable origins
- Security headers including `X-Content-Type-Options: nosniff`

### Content Types
Supports comprehensive MIME type mapping for:
- Images (PNG, JPG, WebP, SVG, ICO)
- Documents (PDF, JSON, XML)
- Applications (DMG, PKG, ZIP)
- Video (MP4, WebM)
- Fonts (WOFF, WOFF2, TTF, OTF)

## Request Flow

1. Edge cache check (Cloudflare CDN)
2. Origin/referer validation
3. R2 object retrieval
4. Conditional request handling (ETag, If-Modified-Since)
5. Response construction with appropriate headers
6. Edge cache storage for future requests

## Testing

- Health check endpoint: `/health` returns JSON status
- Local development runs on `http://localhost:8787`
- Production deployment uses custom domains (e.g., `cdn.tinykit.app`)

## Error Handling

The Worker returns appropriate HTTP status codes:
- 400: No file path provided
- 403: Invalid origin (hotlink protection)
- 404: File not found in R2
- 405: Method not allowed (only GET/HEAD supported)
- 413: File too large
- 500: Internal server error with detailed message

## Cost Optimization

Using Worker to access R2 provides zero egress costs compared to direct R2.dev public access, making this architecture highly cost-effective for CDN delivery.