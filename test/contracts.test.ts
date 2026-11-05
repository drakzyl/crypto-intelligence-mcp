import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = readFileSync(resolve(process.cwd(), "src/index.ts"), "utf8");
const names = [...source.matchAll(/\{name:"([a-z_]+)"/g)].map((m) => m[1]);
const chartBlock = source.split("const jobs:Record<string,()=>Promise<unknown>>={", 2)[1]?.split("\n  };", 1)[0] ?? "";
const chartNames = [...chartBlock.matchAll(/^\s{4}([a-z_]+):/gm)].map((m) => m[1]);

describe("MCP contract inventory", () => {
  it("declares 35 unique tools", () => {
    expect(names).toHaveLength(35);
    expect(new Set(names).size).toBe(35);
  });
  it("declares ten chart series", () => {
    expect(chartNames).toHaveLength(10);
    expect(new Set(chartNames).size).toBe(10);
  });
  it("includes the five selected exchanges", () => {
    for (const exchange of ["binance", "coinbase", "bybit", "okx", "hyperliquid"]) {
      expect(source).toContain(`"${exchange}"`);
    }
  });
});


describe("security baseline", () => {
  const config = readFileSync(resolve(process.cwd(), "wrangler.toml"), "utf8");
  it("configures separate pre-auth and authenticated rate limiters", () => {
    expect(config).toContain('name = "PREAUTH_RATE_LIMITER"');
    expect(config).toContain('name = "AUTH_RATE_LIMITER"');
    expect(source).toContain("env.PREAUTH_RATE_LIMITER.limit");
    expect(source).toContain("env.AUTH_RATE_LIMITER.limit");
  });
  it("enforces bearer authentication and a minimum token length", () => {
    expect(source).toContain('env.AUTH_TOKEN.length<32');
    expect(source).toContain('auth.startsWith("Bearer ")');
    expect(source).toContain("constantTimeEqual(supplied,env.AUTH_TOKEN)");
  });
  it("bounds MCP request bodies and validates market symbols", () => {
    expect(source).toContain("MAX_MCP_BODY_BYTES = 65_536");
    expect(source).toContain("symbolSchema = z.string().regex");
  });
  it("does not expose upstream response bodies or raw unexpected errors", () => {
    expect(source).not.toContain('body.slice(0, 300)');
    expect(source).toContain('"The provider request could not be completed."');
  });
  it("emits redacted structured audit events", () => {
    expect(source).toContain('audit("authentication_failed"');
    expect(source).toContain('audit("tool_completed"');
    expect(source).toContain('component:"crypto-intelligence-mcp"');
  });
});
