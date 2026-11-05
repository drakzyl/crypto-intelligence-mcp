# Contract and implementation status

All 35 MCP tool names are registered in `src/index.ts` with JSON input schemas. Result payloads are JSON text inside MCP `content`. A tool returns `isError: true` with a stable error code when its source is unavailable.

## Stable error codes

- `PROVIDER_CREDENTIAL_MISSING`: required secret is absent.
- `PROVIDER_ADAPTER_NOT_VERIFIED`: key exists, but endpoint/schema/entitlement has not been validated.
- `UNSUPPORTED_MARKET`: venue does not offer the requested product.
- `UNSUPPORTED_ENDPOINT`: venue API route is not implemented.
- `VENUE_DATA_LIMITATION`: venue does not expose the required public history/feed.
- `UPSTREAM_HTTP_ERROR`, `INVALID_PROVIDER_RESPONSE`, `NO_MARKET_DATA`, `INSUFFICIENT_MARKET_DATA`, `INVALID_STRATEGY`, `OPTIONS_DATA_PROVIDER_UNAVAILABLE`.

## Read-only boundary

There are no order placement, cancellation, transfer, withdrawal, or account-trading endpoints. Exchange API credentials are not requested by this version. Future execution support must be separately designed with scoped keys, allowlists, explicit user confirmations, risk limits, idempotency, audit logging, and a kill switch.
