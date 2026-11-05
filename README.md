# Crypto Intelligence — Cloudflare Workers MCP backend

Private, read-only-first MCP service. The Worker exposes Streamable HTTP at `/mcp`, protects it with a bearer secret, and uses live public REST endpoints where implemented. It never fabricates missing provider data.

## Contract inventory

This package registers **35 tools**. The requested 10 chart views are composed from live series returned by the underlying metric tools rather than separate synthetic chart tools.

| # | Tool | Coverage |
|---:|---|---|
| 1 | `market_snapshot` | Live tickers + OHLCV for Binance, Coinbase, Bybit, OKX, Hyperliquid |
| 2 | `cvd` | Recent-trade-derived CVD where venue feed is implemented |
| 3 | `orderbook_depth` | Live L2 depth and imbalance, five venues |
| 4 | `coinbase_premium` | Coinbase/Binance spot comparison |
| 5 | `funding_rates` | Binance, Bybit, OKX, Hyperliquid |
| 6 | `open_interest` | Binance, Bybit, OKX, Hyperliquid |
| 7 | `liquidation_heatmap` | CoinGlass adapter; advanced endpoint availability depends on verified endpoint contracts and account entitlement |
| 8 | `liquidations` | Binance force-order endpoint; other venue limits explicit |
| 9 | `liquidation_map` | CoinGlass adapter; advanced endpoint availability depends on verified endpoint contracts and account entitlement |
| 10 | `liquidation_history_heatmap` | CoinGlass adapter gated; unavailable until verified |
| 11 | `top_trader_long_short` | Binance/Bybit public ratio endpoints |
| 12 | `taker_buy_sell_ratio` | Binance Futures |
| 13 | `volume_profile_vpvr` | OHLCV typical-price approximation, clearly labeled (not trade-level VPVR) |
| 14 | `anchored_vwap` | OHLCV typical-price approximation |
| 15 | `open_interest_by_exchange` | Binance, Bybit, OKX, Hyperliquid |
| 16 | `funding_by_exchange` | Binance, Bybit, OKX, Hyperliquid |
| 17 | `spot_volume_delta` | Recent-trade-derived delta, supported venues only |
| 18 | `premium_by_exchange` | Coinbase/Bybit/OKX versus Binance, quote-basis caveat |
| 19 | `long_short_ratio_history` | Binance Futures |
| 20 | `top_trader_history` | Binance Futures |
| 21 | `cumulative_liquidation_map` | CoinGlass adapter gated; unavailable until verified |
| 22 | `stablecoin_supply_ratio` | CryptoQuant/Glassnode adapter gated; unavailable until verified |
| 23 | `exchange_netflow` | CryptoQuant/Glassnode adapter gated; unavailable until verified |
| 24 | `etf_flows` | Farside API contract unverified; unavailable until verified |
| 25 | `spot_perpetual_volume_ratio` | Binance 24h turnover |
| 26 | `stablecoin_inflows` | CryptoQuant/Glassnode adapter gated; unavailable until verified |
| 27 | `coinbase_spot_volume` | Coinbase Exchange ticker/volume |
| 28 | `orderbook_imbalance_alert` | Live book threshold check |
| 29 | `liquidation_price_calculator` | Local approximate linear isolated-margin calculation |
| 30 | `max_pain_levels` | Unavailable until options-chain provider configured |
| 31 | `paper_trade_backtest` | EMA paper backtest on fetched Binance candles; no live orders |
| 32 | `pnl_sats_converter` | Exact BTC-to-satoshi conversion; optional live USD mark |
| 33 | `macro_dashboard` | Unavailable until licensed macro provider configured |
| 34 | `economic_calendar` | Unavailable until verified calendar provider configured |
| 35 | `security_geopolitical_status` | Combined Binance incident + geopolitical feed; unavailable until verified |

## Ten chart views

The chart-ready time series are derived from: (1) price/volume candles, (2) CVD, (3) order-book depth, (4) funding by exchange, (5) open interest by exchange, (6) liquidation levels, (7) volume profile, (8) anchored VWAP, (9) premium by exchange, and (10) long/short positioning. Each chart must be omitted or visibly marked unavailable if its underlying live series cannot be retrieved. No hard-coded chart values are shipped.

## Deploy

Requirements: Node.js 20+, npm, and a Cloudflare account with Workers enabled.

```bash
npm install
cp .dev.vars.example .dev.vars
# Replace AUTH_TOKEN with a long random value in .dev.vars for local testing
npm run typecheck
npm run dev
```

Set separate staging and production bearer secrets (do not put them in `wrangler.toml`, source, Git, or chat):

```bash
npx wrangler secret put AUTH_TOKEN --env staging
npx wrangler secret put AUTH_TOKEN
```

Deploy and validate staging before production:

```bash
npx wrangler deploy --env staging
# Smoke-test the staging endpoint, then:
npx wrangler deploy
```

Optional data-provider secrets (only if you hold valid entitlements):

```bash
npx wrangler secret put COINGLASS_API_KEY
npx wrangler secret put CRYPTOQUANT_API_KEY
npx wrangler secret put GLASSNODE_API_KEY
npx wrangler secret put FARSIDE_API_KEY
```

Then deploy:

```bash
npm run deploy
```

Verify `/health` and then use the exact endpoint `https://<worker-subdomain>.workers.dev/mcp` with `Authorization: Bearer <AUTH_TOKEN>`. The MCP endpoint is not publicly usable without the secret. Keep the bearer token in the MCP client's secure credential store.

## Important scope boundaries

- This source package is prepared for Cloudflare Workers deployment, but it is **not build-verified or deployed** by this package build. Complete `DEPLOYMENT-CHECKLIST.md` before production use.
- Public exchange endpoints are read-only. No exchange order-placement capability is implemented.
- `paper_trade_backtest` is simulation only; it does not execute or submit orders.
- CoinGlass, CryptoQuant, Glassnode, Farside, macro/news, and options-chain metrics remain explicit errors until exact current endpoints, response schemas, subscription entitlements, and credentials are verified. Merely setting a key does not activate an unverified adapter.
- TradingView does not provide a general public market-data API for these indicators; no unofficial scrape is used.
- No credentials are included. Worker secrets are the supported deployment mechanism.
- Exchange symbols and product availability vary. A venue may return a per-venue error while other venue results succeed.
- OHLCV-derived VPVR/VWAP and trade-feed CVD are explicitly approximations, not substitutes for licensed tick-level datasets.

## Security

- Bearer authentication is mandatory; missing `AUTH_TOKEN` returns 503 and invalid tokens return 401.
- CORS is disabled by default. Add a narrowly scoped origin policy only if a browser client is intentionally supported.
- Do not expose the health endpoint as a source of secrets; it returns only build/runtime metadata.
- Rotate tokens and provider keys through Wrangler secrets.


## Security baseline

This build includes separate pre-authentication and authenticated Cloudflare rate-limit bindings, bearer-token authentication, strict symbol validation, 64 KiB MCP request-body limits, 2 MB upstream response limits, generic upstream errors, structured redacted audit logs, and security response headers. See [SECURITY-REVIEW.md](SECURITY-REVIEW.md) for limitations and residual risks.

Cloudflare's built-in rate limiter is approximate per location. It is not a globally strict quota. The sample namespace IDs in `wrangler.toml` must be unique in your account.
