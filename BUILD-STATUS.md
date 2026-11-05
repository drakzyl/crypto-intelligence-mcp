# Build and validation status

Build package prepared: 2026-11-05

## Verified before the latest CoinGlass adapter change

- Dependency installation completed in Cloudflare CI.
- `npm run typecheck` passed.
- `npm test` passed: 8/8 tests.
- `npm audit --audit-level=high` reported zero vulnerabilities.
- CI deployment command succeeded but deployed to the wrong Worker name because the build trigger overrode the Wrangler staging name. This was an isolation failure; do not treat that deployment as a valid staging release.

## Latest source change — not yet build-verified

- Added CoinGlass API v4 authentication using the `CG-API-KEY` header.
- Implemented historical pair-liquidation data via `/api/futures/liquidation/history`; the selected aggregation and historical window are currently conservative defaults, while product-level entitlement checks remain runtime-scoped.
- Kept unverified price-level map adapters explicitly unavailable until the exact endpoint contract and active account entitlement are validated.
- Added contract tests for CoinGlass header authentication, endpoint selection, timestamp bounds and runtime capability gating.

## Release status

**Not production-ready.** The latest source change still needs a fresh typecheck and test run. Do not trigger the existing Cloudflare build pipeline until its deployment target is corrected: the prior trigger overrode the configured staging Worker name and deployed staging configuration to the existing production-named Worker. A CoinGlass key must be stored privately as the `COINGLASS_API_KEY` Worker secret before live API validation. Never commit or paste the key into source, GitHub, build variables or chat.
