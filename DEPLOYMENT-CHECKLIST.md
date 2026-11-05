# Cloudflare deployment checklist

## Prerequisites
- Node.js 20+ and npm
- Cloudflare account with Workers enabled
- Wrangler CLI (installed from this package)

## Local validation
```bash
npm install
npm run typecheck
npm test
npm audit
npx wrangler deploy --dry-run
```

## Configure Cloudflare
1. Review `wrangler.toml`; choose `namespace_id` values unique in your Cloudflare account. The sample IDs `91001`–`91004` are placeholders and must be unique in your account.
2. Authenticate: `npx wrangler login`.
3. Set a strong random token (at least 32 characters) for staging: `npx wrangler secret put AUTH_TOKEN --env staging`.
4. Set a separate strong production token: `npx wrangler secret put AUTH_TOKEN`. Never reuse the staging token.
5. Only add provider secrets after the corresponding adapter is verified. Never paste secrets into chat or commit them. Add provider secrets separately for staging and production.
6. Deploy staging first: `npx wrangler deploy --env staging`; validate it; then deploy production: `npx wrangler deploy`.

## Deploy
```bash
npx wrangler deploy
```

The endpoint is normally `https://<worker-name>.<account-subdomain>.workers.dev/mcp`. `/health` is a public liveness endpoint and does not expose credentials.

## Smoke tests
```bash
curl -i https://<worker-name>.<account-subdomain>.workers.dev/health
curl -i https://<worker-name>.<account-subdomain>.workers.dev/mcp
curl -i -H 'Authorization: Bearer <your-token>' -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"smoke-test","version":"1.0.0"}}}' https://<worker-name>.<account-subdomain>.workers.dev/mcp
```

Expected: `/health` returns 200; unauthenticated `/mcp` returns 401; authenticated initialization returns a valid MCP response. Verify rate limiting in staging before production.

## Operational cautions
- Rate limiting bindings are approximate per Cloudflare location; they are not a strict global quota.
- Do not enable production until the security review and remaining risks in `SECURITY-REVIEW.md` have been reviewed.
- The server is read-only. Do not add order execution or withdrawal permissions.
