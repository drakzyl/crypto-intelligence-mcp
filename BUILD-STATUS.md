# Build and validation status

Updated: 2026-11-05

## Main project scope

The deliverable remains the complete private, read-only Crypto Intelligence MCP:
- Five exchange integrations: Binance, Coinbase, Bybit, OKX and Hyperliquid.
- 35 MCP tool contracts and 10 chart-ready datasets.
- Bearer authentication, rate limiting, input/response bounds, redacted audit logs and isolated staging/production environments.
- No order placement, transfers or withdrawals.

Provider plan tiers do not define the architecture or reduce the five-exchange scope. Optional provider metrics are exposed only where the exact endpoint, schema and entitlement are verified; unavailable metrics return explicit errors rather than fabricated substitutes.

## Verified build history

- A previous Cloudflare CI run passed dependency installation, typecheck, all then-current tests and high-severity dependency audit.
- That run's deploy command targeted the wrong Worker because the build trigger overrode the Wrangler staging name. It is not a valid staging release.
- The existing Cloudflare build trigger deployment command has been changed to a harmless pause message while target isolation is corrected.
- A later CI run passed typecheck, 9/9 tests and npm audit --audit-level=high with zero reported vulnerabilities before the latest Hyperliquid adapter additions.

## Latest changes requiring fresh validation

- CoinGlass API v4 historical pair-liquidation adapter; entitlement-dependent interval and history; price-level map endpoints remain separately gated.
- Hyperliquid candleSnapshot support for supported intervals.
- Hyperliquid recentTrades support for trade-side delta/CVD.
- Contract tests added for the Hyperliquid adapter paths.

## Release blockers

**Not production-ready.**
1. Run a fresh typecheck, complete test suite and dependency audit against the latest commit.
2. Create a distinct staging Worker and a separate CI build trigger bound to that Worker.
3. Restore/verify the existing production Worker independently; do not let staging builds target it.
4. Configure distinct runtime AUTH_TOKEN secrets and provider secrets in the correct Worker environments.
5. Verify exchange adapters and optional provider adapters against live endpoints.
6. Run staging smoke tests for /health, unauthenticated /mcp, authenticated MCP initialization, invalid bearer token, rate limiting and tool-level data responses.
7. Complete a security review and only then promote a tested version to production.

Never put API keys or bearer tokens in Git, source, build variables, logs or chat. Use Cloudflare Worker runtime secrets.