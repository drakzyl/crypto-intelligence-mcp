# Security review — Crypto Intelligence MCP Worker

## Scope
This review covers the source-level controls in this repository. It is not a penetration test, independent security certification, or confirmation of a live Cloudflare deployment.

## Implemented controls

- **Authentication:** bearer token required for `/mcp`; token must be at least 32 characters; comparison is constant-time over the maximum byte length. Store it with `wrangler secret put AUTH_TOKEN`.
- **Rate limiting:** separate pre-authentication and authenticated bindings. The authenticated key is a SHA-256 digest of the bearer token; the raw token is never used as a limiter key. Current defaults are 120 and 300 requests per 60 seconds respectively.
- **Sanitization:** only GET/POST are accepted; POST requires JSON; request body is capped at 64 KiB; market symbols are uppercase alphanumeric values of 2–30 characters; upstream response bodies are capped at 2 MB; upstream HTTP response bodies and unexpected exception messages are not returned to clients.
- **Audit:** structured request and tool lifecycle logs contain request IDs, tool names, status and duration. They intentionally exclude authorization headers, tokens, request bodies, query strings and provider payloads.
- **Isolation:** no API credentials in source or Wrangler configuration; `.dev.vars` is ignored; separate `staging` and production Worker environments have independent rate-limit namespaces. Set distinct secrets in each environment. CORS is disabled.
- **Response hardening:** no-store, nosniff, no-referrer and HSTS headers are added to responses.
- **Trading safety:** no exchange order-placement or withdrawal code is included.

## Important limitations / residual risks

1. Cloudflare Workers Rate Limiting bindings are approximate and scoped per Cloudflare location, not a globally strict quota. A request burst may exceed the configured threshold. Use a Durable Object for strict globally coordinated quotas.
2. The pre-authentication limiter uses the connecting IP. Shared mobile-carrier NAT or corporate egress can cause unrelated users to share a limit. Tune it to your expected traffic; an edge WAF rule is another option.
3. A single bearer token is shared-secret authentication, not per-user identity, OAuth, or role-based access control. Anyone possessing it can call every exposed tool. Rotate it if exposure is suspected.
4. HSTS is appropriate for the HTTPS `workers.dev` endpoint. Do not reuse this header policy for a non-HTTPS origin.
5. Cloudflare account administrators and deployment automation with secret access remain privileged. Protect the Cloudflare account with MFA and least-privilege roles.
6. Third-party public APIs can change schemas, throttle requests, or return incomplete data. The Worker has no control over provider availability.
7. CoinGlass API v4 uses the `CG-API-KEY` request header. The implemented pair-liquidation history adapter uses the documented Hobbyist-compatible `/api/futures/liquidation/history` endpoint at 4h granularity (Hobbyist minimum). Price-level liquidation maps remain blocked because CoinGlass documents them as Professional/Enterprise-only. The CoinGlass key must be stored as the `COINGLASS_API_KEY` Worker secret and rotated if exposed. CryptoQuant, Glassnode, Farside and macro adapters remain unavailable until their endpoints, schemas and entitlements are verified.
8. The 64 KiB body cap and 2 MB upstream response cap are application controls; validate them against the MCP clients and providers you actually use.

## Deployment gate

Before production: install from the lockfile, run typecheck and tests, run `npm audit`, run `wrangler deploy --dry-run`, inspect the bundle, set a strong secret, confirm both rate-limit namespaces are unique in the account, and test valid/invalid authentication and 429 behavior on a staging Worker. Do not claim production readiness until these checks and an external review are complete.
