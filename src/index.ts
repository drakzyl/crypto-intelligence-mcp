import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

type Env = {
  AUTH_TOKEN?: string;
  APP_ENV?: string;
  MCP_ROUTE?: string;
  COINGLASS_API_KEY?: string;
  CRYPTOQUANT_API_KEY?: string;
  GLASSNODE_API_KEY?: string;
  FARSIDE_API_KEY?: string;
  MACRO_DATA_API_KEY?: string;
  PREAUTH_RATE_LIMITER: RateLimitBinding;
  AUTH_RATE_LIMITER: RateLimitBinding;
};

type RateLimitBinding = { limit: (options: { key: string }) => Promise<{ success: boolean }> };

type Json = Record<string, unknown>;
type Exchange = "binance" | "coinbase" | "bybit" | "okx" | "hyperliquid";
const EXCHANGES: Exchange[] = ["binance", "coinbase", "bybit", "okx", "hyperliquid"];
const DEFAULT_SYMBOL = "BTCUSDT";
const symbolSchema = z.string().regex(/^[A-Z0-9]{2,30}$/, "Use an uppercase alphanumeric market symbol.");
const MAX_MCP_BODY_BYTES = 65_536;

class ProviderError extends Error {
  constructor(public code: string, message: string, public provider?: string, public remediation?: string) {
    super(message);
  }
}

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify({ status: "ok", as_of: new Date().toISOString(), data }) }] };
}
function fail(error: unknown) {
  const e = error instanceof ProviderError ? error : new ProviderError("UPSTREAM_ERROR", "The request could not be completed.");
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify({
      status: "error", error: { code: e.code, message: e.message, provider: e.provider ?? null, remediation: e.remediation ?? null },
      as_of: new Date().toISOString()
    }) }]
  };
}

async function getJson(url: string, init: RequestInit = {}): Promise<any> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(12_000), headers: { accept: "application/json", ...(init.headers || {}) } });
  const host = new URL(url).hostname;
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength > 2_000_000) throw new ProviderError("UPSTREAM_RESPONSE_TOO_LARGE", "Provider response exceeded the permitted size.", host);
  const body = await response.text();
  if (body.length > 2_000_000) throw new ProviderError("UPSTREAM_RESPONSE_TOO_LARGE", "Provider response exceeded the permitted size.", host);
  if (!response.ok) throw new ProviderError("UPSTREAM_HTTP_ERROR", `Provider returned HTTP ${response.status}.`, host, "Retry later or check the provider's service status and API limits.");
  try { return JSON.parse(body); } catch { throw new ProviderError("INVALID_PROVIDER_RESPONSE", "Provider returned non-JSON content.", host); }
}
async function postJson(url: string, body: unknown): Promise<any> {
  return getJson(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}
function symbolFor(exchange: Exchange, symbol: string): string {
  if (exchange === "coinbase") return symbol.replace(/USDT?$/, "-USD").replace(/([A-Z]+)(USD)$/, "$1-$2");
  if (exchange === "hyperliquid") return symbol.replace(/USDT?$/, "");
  if (exchange === "okx") return symbol.replace(/USDT?$/, "-USDT-SWAP");
  return symbol;
}

async function ticker(exchange: Exchange, symbol: string): Promise<Json> {
  const s = symbolFor(exchange, symbol);
  const spotId = symbol.replace(/USDT?$/, "-USDT");
  switch (exchange) {
    case "binance": {
      const [p, t] = await Promise.all([
        getJson(`https://api.binance.com/api/v3/ticker/price?symbol=${encodeURIComponent(s)}`),
        getJson(`https://api.binance.com/api/v3/ticker/24hr?symbol=${encodeURIComponent(s)}`)
      ]);
      return { exchange, symbol: s, price: Number(p.price), change_24h_pct: Number(t.priceChangePercent), volume_24h: Number(t.quoteVolume), high_24h: Number(t.highPrice), low_24h: Number(t.lowPrice), source: "Binance Spot REST" };
    }
    case "coinbase": {
      const p = await getJson(`https://api.exchange.coinbase.com/products/${encodeURIComponent(s)}/ticker`);
      return { exchange, symbol: s, price: Number(p.price), volume_24h_base: Number(p.volume), source: "Coinbase Exchange REST" };
    }
    case "bybit": {
      const p = await getJson(`https://api.bybit.com/v5/market/tickers?category=spot&symbol=${encodeURIComponent(s)}`);
      const t = p?.result?.list?.[0]; if (!t) throw new ProviderError("NO_MARKET_DATA", `No Bybit ticker for ${s}`, "Bybit");
      return { exchange, symbol: s, price: Number(t.lastPrice), change_24h_pct: Number(t.price24hPcnt) * 100, volume_24h: Number(t.turnover24h), high_24h: Number(t.highPrice24h), low_24h: Number(t.lowPrice24h), source: "Bybit V5" };
    }
    case "okx": {
      const p = await getJson(`https://www.okx.com/api/v5/market/ticker?instId=${encodeURIComponent(spotId)}`);
      const t = p?.data?.[0]; if (!t) throw new ProviderError("NO_MARKET_DATA", `No OKX ticker for ${s}`, "OKX");
      return { exchange, symbol: s, price: Number(t.last), volume_24h: Number(t.volCcy24h), high_24h: Number(t.high24h), low_24h: Number(t.low24h), source: "OKX V5" };
    }
    case "hyperliquid": {
      const p = await postJson("https://api.hyperliquid.xyz/info", { type: "allMids" });
      const price = p?.[s]; if (!price) throw new ProviderError("NO_MARKET_DATA", `No Hyperliquid mid for ${s}`, "Hyperliquid");
      return { exchange, symbol: s, price: Number(price), source: "Hyperliquid Info API (mid; not last trade)" };
    }
  }
}

async function orderbook(exchange: Exchange, symbol: string, limit: number): Promise<Json> {
  const s = symbolFor(exchange, symbol);
  let bids: any[] = [], asks: any[] = [], source = "";
  if (exchange === "binance") { const p = await getJson(`https://api.binance.com/api/v3/depth?symbol=${s}&limit=${Math.min(limit, 5000)}`); bids=p.bids; asks=p.asks; source="Binance Spot depth"; }
  if (exchange === "coinbase") { const p = await getJson(`https://api.exchange.coinbase.com/products/${s}/book?level=2`); bids=p.bids; asks=p.asks; source="Coinbase Exchange level 2"; }
  if (exchange === "bybit") { const p = await getJson(`https://api.bybit.com/v5/market/orderbook?category=linear&symbol=${s}&limit=${Math.min(limit, 200)}`); bids=p.result?.b||[]; asks=p.result?.a||[]; source="Bybit V5 orderbook"; }
  if (exchange === "okx") { const p = await getJson(`https://www.okx.com/api/v5/market/books?instId=${s}&sz=${Math.min(limit, 400)}`); bids=p.data?.[0]?.bids||[]; asks=p.data?.[0]?.asks||[]; source="OKX V5 books"; }
  if (exchange === "hyperliquid") { const p = await postJson("https://api.hyperliquid.xyz/info", { type:"l2Book", coin:s }); bids=p?.levels?.[0]||[]; asks=p?.levels?.[1]||[]; source="Hyperliquid l2Book"; }
  const norm = (xs: any[]) => xs.slice(0, limit).map(x => ({ price: Number(x[0] ?? x.px), size: Number(x[1] ?? x.sz) }));
  const b=norm(bids), a=norm(asks); const bidNotional=b.reduce((n,x)=>n+x.price*x.size,0), askNotional=a.reduce((n,x)=>n+x.price*x.size,0);
  return { exchange, symbol:s, bids:b, asks:a, bid_notional:bidNotional, ask_notional:askNotional, imbalance:(bidNotional+askNotional)>0?(bidNotional-askNotional)/(bidNotional+askNotional):null, source };
}

async function funding(exchange: Exchange, symbol: string): Promise<Json> {
  const s=symbolFor(exchange,symbol);
  if (exchange === "binance") { const p=await getJson(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${s}`); return {exchange,symbol:s,funding_rate:Number(p.lastFundingRate),next_funding_time:p.nextFundingTime,mark_price:Number(p.markPrice),source:"Binance USD-M Futures"}; }
  if (exchange === "bybit") { const p=await getJson(`https://api.bybit.com/v5/market/tickers?category=linear&symbol=${s}`); const t=p.result?.list?.[0]; if(!t) throw new ProviderError("NO_MARKET_DATA","No funding record","Bybit"); return {exchange,symbol:s,funding_rate:Number(t.fundingRate),next_funding_time:t.nextFundingTime,mark_price:Number(t.markPrice),source:"Bybit V5"}; }
  if (exchange === "okx") { const p=await getJson(`https://www.okx.com/api/v5/public/funding-rate?instId=${s}`); const t=p.data?.[0]; if(!t) throw new ProviderError("NO_MARKET_DATA","No funding record","OKX"); return {exchange,symbol:s,funding_rate:Number(t.fundingRate),next_funding_time:t.nextFundingTime,source:"OKX V5"}; }
  if (exchange === "hyperliquid") { const [meta,ctx]=await postJson("https://api.hyperliquid.xyz/info",{type:"metaAndAssetCtxs"}); const idx=meta.universe.findIndex((x:any)=>x.name===s); if(idx<0) throw new ProviderError("NO_MARKET_DATA",`Unknown Hyperliquid asset ${s}`,"Hyperliquid"); return {exchange,symbol:s,funding_rate:Number(ctx[idx].funding),mark_price:Number(ctx[idx].markPx),open_interest:Number(ctx[idx].openInterest),source:"Hyperliquid metaAndAssetCtxs"}; }
  throw new ProviderError("UNSUPPORTED_MARKET","Coinbase Exchange does not expose perpetual funding for this market","Coinbase");
}

async function openInterest(exchange: Exchange, symbol: string): Promise<Json> {
  const s=symbolFor(exchange,symbol);
  if(exchange==="binance"){const p=await getJson(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${s}`);return {exchange,symbol:s,open_interest:Number(p.openInterest),time:p.time,source:"Binance USD-M Futures"};}
  if(exchange==="bybit"){const p=await getJson(`https://api.bybit.com/v5/market/open-interest?category=linear&symbol=${s}&intervalTime=5min&limit=1`);const x=p.result?.list?.[0];if(!x)throw new ProviderError("NO_MARKET_DATA","No OI data","Bybit");return {exchange,symbol:s,open_interest:Number(x.openInterest),time:x.timestamp,source:"Bybit V5"};}
  if(exchange==="okx"){const p=await getJson(`https://www.okx.com/api/v5/public/open-interest?instType=SWAP&instId=${s}`);const x=p.data?.[0];if(!x)throw new ProviderError("NO_MARKET_DATA","No OI data","OKX");return {exchange,symbol:s,open_interest:Number(x.oi),open_interest_currency:Number(x.oiCcy),source:"OKX V5"};}
  if(exchange==="hyperliquid"){const [m,c]=await postJson("https://api.hyperliquid.xyz/info",{type:"metaAndAssetCtxs"});const i=m.universe.findIndex((x:any)=>x.name===s);if(i<0)throw new ProviderError("NO_MARKET_DATA",`Unknown asset ${s}`,"Hyperliquid");return {exchange,symbol:s,open_interest:Number(c[i].openInterest),source:"Hyperliquid"};}
  throw new ProviderError("UNSUPPORTED_MARKET","Coinbase Exchange does not offer perpetual open interest","Coinbase");
}

async function candles(exchange: Exchange, symbol: string, interval: string, limit: number): Promise<any[]> {
  const s=symbolFor(exchange,symbol);
  if(exchange==="binance"){const p=await getJson(`https://api.binance.com/api/v3/klines?symbol=${s}&interval=${interval}&limit=${Math.min(limit,1000)}`);return p.map((x:any)=>({time:x[0],open:+x[1],high:+x[2],low:+x[3],close:+x[4],volume:+x[5],quote_volume:+x[7],trades:x[8]}));}
  if(exchange==="bybit"){const p=await getJson(`https://api.bybit.com/v5/market/kline?category=spot&symbol=${s}&interval=${intervalMap(interval)}&limit=${Math.min(limit,1000)}`);return (p.result?.list||[]).reverse().map((x:any)=>({time:+x[0],open:+x[1],high:+x[2],low:+x[3],close:+x[4],volume:+x[5],quote_volume:+x[6]}));}
  if(exchange==="okx"){const bar=interval==="1h"?"1H":interval==="4h"?"4H":interval.toUpperCase();const p=await getJson(`https://www.okx.com/api/v5/market/candles?instId=${s.replace(/-SWAP$/, "")}&bar=${bar}&limit=${Math.min(limit,300)}`);return (p.data||[]).reverse().map((x:any)=>({time:+x[0],open:+x[1],high:+x[2],low:+x[3],close:+x[4],volume:+x[5],quote_volume:+x[6]}));}
  if(exchange==="coinbase"){const gran=interval==="1m"?60:interval==="5m"?300:interval==="15m"?900:interval==="1h"?3600:interval==="4h"?21600:86400;const p=await getJson(`https://api.exchange.coinbase.com/products/${s}/candles?granularity=${gran}`);return p.slice(0,limit).reverse().map((x:any)=>({time:x[0]*1000,low:+x[1],high:+x[2],open:+x[3],close:+x[4],volume:+x[5]}));}
  throw new ProviderError("UNSUPPORTED_ENDPOINT","Hyperliquid candle history requires a separate historical candle request implementation; no substitute data is returned","Hyperliquid");
}
function intervalMap(v:string){return ({"1m":"1","3m":"3","5m":"5","15m":"15","30m":"30","1h":"60","2h":"120","4h":"240","6h":"360","12h":"720","1d":"D","1w":"W"} as Record<string,string>)[v]||"60";}

async function tradesCvd(exchange: Exchange, symbol: string, limit: number): Promise<Json> {
  const s=symbolFor(exchange,symbol); let rows:any[]=[]; let source="";
  if(exchange==="binance"){rows=await getJson(`https://api.binance.com/api/v3/aggTrades?symbol=${s}&limit=${Math.min(limit,1000)}`);source="Binance aggTrades";}
  else if(exchange==="bybit"){const p=await getJson(`https://api.bybit.com/v5/market/recent-trade?category=linear&symbol=${s}&limit=${Math.min(limit,1000)}`);rows=p.result?.list||[];source="Bybit recent trades";}
  else if(exchange==="okx"){const p=await getJson(`https://www.okx.com/api/v5/market/trades?instId=${s}&limit=${Math.min(limit,500)}`);rows=p.data||[];source="OKX recent trades";}
  else if(exchange==="coinbase"){rows=await getJson(`https://api.exchange.coinbase.com/products/${s}/trades?limit=${Math.min(limit,1000)}`);source="Coinbase Exchange trades";}
  else throw new ProviderError("UNSUPPORTED_ENDPOINT","Hyperliquid public recent-trade history is not wired in this release","Hyperliquid");
  let buy=0,sell=0;for(const r of rows){const qty=Number(r.q??r.size??r.sz??r[1]??0);const side=String(r.m!==undefined?(r.m?"sell":"buy"):r.side??r.side??"").toLowerCase();if(side==="buy"||side==="b")buy+=qty;else if(side==="sell"||side==="s"||side==="true")sell+=qty;}
  return {exchange,symbol:s,buy_volume:buy,sell_volume:sell,cvd:buy-sell,trade_count:rows.length,unit:"base asset; not USD notional",source,methodology:"Aggressor side inferred from venue trade schema; exchange-specific semantics may differ"};
}

function requireKey(env:Env,key:keyof Env,provider:string){const value=env[key];if(typeof value!=="string"||!value.trim())throw new ProviderError("PROVIDER_CREDENTIAL_MISSING",`${provider} API credentials are not configured. This metric is unavailable; no estimate or substitute is returned.`,provider,`Set the ${String(key)} Worker secret using Wrangler.`);return value.trim();}
async function paidProvider(env:Env, key:keyof Env, provider:string, endpoint:string, params:Record<string,string>={}):Promise<any>{
  const token=requireKey(env,key,provider); const u=new URL(endpoint);for(const [k,v] of Object.entries(params))u.searchParams.set(k,v);
  const sep=u.searchParams.has("api_key")?"":"";void sep;
  return getJson(u.toString(),{headers:{"api-key":token,"x-api-key":token}});
}

const common = { symbol: symbolSchema.default(DEFAULT_SYMBOL), exchange: z.enum(EXCHANGES).default("binance") };
const period = z.object({ ...common, interval: z.enum(["1m","5m","15m","30m","1h","4h","1d","1w"]).default("1h"), limit: z.number().int().min(1).max(1000).default(200) });
const metricTools: Array<{name:string;description:string;schema:any;run:(a:any,e:Env)=>Promise<unknown>}> = [
 {name:"market_snapshot",description:"Live ticker and OHLCV snapshot from one of Binance, Coinbase, Bybit, OKX or Hyperliquid. Returns only venue-reported fields.",schema:z.object({symbol:symbolSchema.default(DEFAULT_SYMBOL),exchanges:z.array(z.enum(EXCHANGES)).default(EXCHANGES),interval:z.enum(["1m","5m","15m","1h","4h","1d"]).default("1h"),candle_limit:z.number().int().min(1).max(500).default(100),include_charts:z.boolean().default(true)}),run:async(a,e)=>{const out:any={};for(const x of a.exchanges){try{out[x]={ticker:await ticker(x,a.symbol),candles:await candles(x,a.symbol,a.interval,a.candle_limit)};}catch(e){out[x]={error:serializeError(e)};}}const result:any={symbol:a.symbol,exchanges:out};if(a.include_charts)result.charts=await buildTenCharts(a.symbol,a.interval,a.candle_limit,e);return result;}},
 {name:"cvd",description:"Trade-side-derived cumulative volume delta snapshot; venue coverage and side semantics are disclosed.",schema:z.object({...common,limit:z.number().int().min(10).max(1000).default(500)}),run:async(a)=>tradesCvd(a.exchange,a.symbol,a.limit)},
 {name:"orderbook_depth",description:"Live L2 order book and notional imbalance from the selected venue.",schema:z.object({...common,limit:z.number().int().min(5).max(1000).default(50)}),run:async(a)=>orderbook(a.exchange,a.symbol,a.limit)},
 {name:"coinbase_premium",description:"Coinbase-versus-Binance spot premium. Uses live spot tickers and reports quote-currency comparability caveats.",schema:z.object({symbol:symbolSchema.default("BTCUSDT")}),run:async(a)=>{const [c,b]=await Promise.all([ticker("coinbase",a.symbol),ticker("binance",a.symbol)]);const premium=(Number(c.price)-Number(b.price))/Number(b.price)*100;return {coinbase_usd:c.price,binance_usdt:b.price,premium_pct:premium,warning:"USD and USDT are treated as approximately comparable; this is not a FX-adjusted institutional premium index."};}},
 {name:"funding_rates",description:"Current perpetual funding rate across supported derivatives venues. Coinbase is excluded because it has no perpetual funding feed.",schema:z.object({symbol:symbolSchema.default(DEFAULT_SYMBOL),exchanges:z.array(z.enum(["binance","bybit","okx","hyperliquid"])).default(["binance","bybit","okx","hyperliquid"])}),run:async(a)=>{const out:any={};for(const x of a.exchanges){try{out[x]=await funding(x,a.symbol);}catch(e){out[x]={error:serializeError(e)};}}return out;}},
 {name:"open_interest",description:"Latest open interest from supported derivatives venues.",schema:z.object({symbol:symbolSchema.default(DEFAULT_SYMBOL),exchanges:z.array(z.enum(["binance","bybit","okx","hyperliquid"])).default(["binance","bybit","okx","hyperliquid"])}),run:async(a)=>{const out:any={};for(const x of a.exchanges){try{out[x]=await openInterest(x,a.symbol);}catch(e){out[x]={error:serializeError(e)};}}return out;}},
 {name:"liquidation_heatmap",description:"Historical pair liquidation heatmap from CoinGlass API v4. Uses 4h aggregation, the minimum interval documented for the Hobbyist plan; returns long/short liquidation USD series, not a price-level liquidation map.",schema:z.object({symbol:symbolSchema.default(DEFAULT_SYMBOL),exchange:z.enum(["binance","bybit","okx","hyperliquid"]).default("binance"),lookback_hours:z.number().int().min(1).max(720).default(24)}),run:async(a,e)=>coinglassRequired(e,"liquidation heatmap",{symbol:a.symbol,exchange:a.exchange,lookback_hours:String(a.lookback_hours)})},
 {name:"liquidations",description:"Recent forced liquidations from a supported exchange public endpoint where available; venue API limitations are surfaced.",schema:z.object({...common,limit:z.number().int().min(1).max(500).default(100)}),run:async(a)=>{if(a.exchange==="binance"){const p=await getJson(`https://fapi.binance.com/fapi/v1/forceOrders?symbol=${a.symbol}&limit=${Math.min(a.limit,100)}`);return {exchange:a.exchange,symbol:a.symbol,events:p,source:"Binance forceOrders; endpoint visibility is limited and not a complete market-wide feed"};}if(a.exchange==="bybit"){throw new ProviderError("VENUE_DATA_LIMITATION","Bybit public REST does not provide a complete historical liquidation tape through this endpoint; use a licensed feed.","Bybit");}throw new ProviderError("VENUE_DATA_LIMITATION",`Liquidation tape is not implemented for ${a.exchange}; no cross-venue estimate is returned.`,a.exchange);}},
 {name:"liquidation_map",description:"Price-level liquidation map from CoinGlass. This endpoint requires Professional or Enterprise; Hobbyist requests fail explicitly with a plan-entitlement error.",schema:z.object({symbol:symbolSchema.default(DEFAULT_SYMBOL),exchange:z.string().default("Binance"),interval:z.string().default("1d")}),run:async(a,e)=>coinglassRequired(e,"liquidation map",a)},
 {name:"liquidation_history_heatmap",description:"Historical pair liquidation series from CoinGlass API v4 at 4h granularity (Hobbyist minimum). Optional millisecond start_time/end_time bounds.",schema:z.object({symbol:symbolSchema.default(DEFAULT_SYMBOL),exchange:z.string().default("Binance"),start_time:z.number().optional(),end_time:z.number().optional()}),run:async(a,e)=>coinglassRequired(e,"historical liquidation heatmap",a)},
 {name:"top_trader_long_short",description:"Top-trader long/short account or position ratio from venue public derivatives data.",schema:z.object({symbol:symbolSchema.default(DEFAULT_SYMBOL),exchange:z.enum(["binance","bybit"]).default("binance"),period:z.enum(["5m","15m","30m","1h","4h","1d"]).default("1h")}),run:async(a)=>{if(a.exchange==="binance"){const p=await getJson(`https://fapi.binance.com/futures/data/topLongShortPositionRatio?symbol=${a.symbol}&period=${a.period}&limit=30`);return {exchange:a.exchange,symbol:a.symbol,series:p,source:"Binance Futures Data API"};}const p=await getJson(`https://api.bybit.com/v5/market/account-ratio?category=linear&symbol=${a.symbol}&period=${a.period}&limit=30`);return {exchange:a.exchange,symbol:a.symbol,series:p.result?.list||[],source:"Bybit V5 account ratio"};}},
 {name:"taker_buy_sell_ratio",description:"Taker buy/sell volume ratio from Binance Futures market statistics.",schema:z.object({symbol:symbolSchema.default(DEFAULT_SYMBOL),period:z.enum(["5m","15m","30m","1h","2h","4h","6h","12h","1d"]).default("1h"),limit:z.number().int().min(1).max(500).default(100)}),run:async(a)=>{const p=await getJson(`https://fapi.binance.com/futures/data/takerlongshortRatio?symbol=${a.symbol}&period=${a.period}&limit=${a.limit}`);return {symbol:a.symbol,series:p,source:"Binance Futures Data API"};}},
 {name:"volume_profile_vpvr",description:"Volume profile by price from live historical candles. This is candle-volume approximation, not trade-level VPVR.",schema:period,run:async(a)=>{const cs=await candles(a.exchange,a.symbol,a.interval,a.limit);const bins=40;const lo=Math.min(...cs.map(x=>x.low)),hi=Math.max(...cs.map(x=>x.high));const step=(hi-lo)/bins;if(!Number.isFinite(step)||step<=0)throw new ProviderError("INSUFFICIENT_MARKET_DATA","Cannot form price bins from returned candles");const hist=Array.from({length:bins},(_,i)=>({price_low:lo+i*step,price_high:lo+(i+1)*step,volume:0}));for(const c of cs){const i=Math.max(0,Math.min(bins-1,Math.floor(((c.high+c.low)/2-lo)/step)));hist[i].volume+=c.volume;}return {symbol:a.symbol,exchange:a.exchange,methodology:"OHLCV typical-price bucket approximation; not true trade-level volume-at-price",bins:hist,poc:hist.reduce((x,y)=>y.volume>x.volume?y:x)};}},
 {name:"anchored_vwap",description:"Anchored VWAP computed from live OHLCV candles, anchored to the returned window start or supplied timestamp.",schema:z.object({...period.shape,anchor_time_ms:z.number().optional()}),run:async(a)=>{const cs=await candles(a.exchange,a.symbol,a.interval,a.limit);const selected=cs.filter(x=>!a.anchor_time_ms||x.time>=a.anchor_time_ms);let pv=0,v=0;for(const c of selected){const tp=(c.high+c.low+c.close)/3;pv+=tp*c.volume;v+=c.volume;}if(!v)throw new ProviderError("INSUFFICIENT_MARKET_DATA","No volume in selected VWAP window");return {symbol:a.symbol,exchange:a.exchange,anchor_time_ms:a.anchor_time_ms??selected[0]?.time,vwap:pv/v,candles: selected.length,source:"Venue OHLCV; typical-price approximation"};}},
 {name:"open_interest_by_exchange",description:"Compare latest open interest across derivatives exchanges. Values are venue-native units and not blindly aggregated.",schema:z.object({symbol:symbolSchema.default(DEFAULT_SYMBOL)}),run:async(a)=>{const out:any={};for(const x of ["binance","bybit","okx","hyperliquid"] as const){try{out[x]=await openInterest(x,a.symbol);}catch(e){out[x]={error:serializeError(e)};}}return out;}},
 {name:"funding_by_exchange",description:"Compare current funding rates across derivatives venues.",schema:z.object({symbol:symbolSchema.default(DEFAULT_SYMBOL)}),run:async(a)=>{const out:any={};for(const x of ["binance","bybit","okx","hyperliquid"] as const){try{out[x]=await funding(x,a.symbol);}catch(e){out[x]={error:serializeError(e)};}}return out;}},
 {name:"spot_volume_delta",description:"Spot trade buy/sell volume delta from exchange recent-trade feeds; not a complete consolidated tape.",schema:z.object({...common,limit:z.number().int().min(10).max(1000).default(500)}),run:async(a)=>tradesCvd(a.exchange,a.symbol,a.limit)},
 {name:"premium_by_exchange",description:"Live spot premium comparison versus Binance reference. Supports only comparable USD/USDT spot tickers and documents quote-currency basis risk.",schema:z.object({symbol:symbolSchema.default(DEFAULT_SYMBOL)}),run:async(a)=>{const ref=await ticker("binance",a.symbol);const out:any={reference:ref};for(const x of ["coinbase","bybit","okx"] as const){try{const t=await ticker(x,a.symbol);out[x]={...t,premium_pct:(Number(t.price)-Number(ref.price))/Number(ref.price)*100};}catch(e){out[x]={error:serializeError(e)};}}return out;}},
 {name:"long_short_ratio_history",description:"Historical long/short ratio from Binance Futures Data API.",schema:z.object({symbol:symbolSchema.default(DEFAULT_SYMBOL),period:z.enum(["5m","15m","30m","1h","2h","4h","6h","12h","1d"]).default("1h"),limit:z.number().int().min(1).max(500).default(100)}),run:async(a)=>getJson(`https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=${a.symbol}&period=${a.period}&limit=${a.limit}`)},
 {name:"top_trader_history",description:"Historical top-trader positioning from Binance Futures Data API.",schema:z.object({symbol:symbolSchema.default(DEFAULT_SYMBOL),period:z.enum(["5m","15m","30m","1h","2h","4h","6h","12h","1d"]).default("1h"),limit:z.number().int().min(1).max(500).default(100)}),run:async(a)=>getJson(`https://fapi.binance.com/futures/data/topLongShortAccountRatio?symbol=${a.symbol}&period=${a.period}&limit=${a.limit}`)},
 {name:"cumulative_liquidation_map",description:"Cumulative price-level liquidation map from CoinGlass. Requires Professional or Enterprise; Hobbyist tier is not entitled.",schema:z.object({symbol:symbolSchema.default(DEFAULT_SYMBOL),exchange:z.string().default("Binance"),range:z.string().default("7d")}),run:async(a,e)=>coinglassRequired(e,"cumulative liquidation map",a)},
 {name:"stablecoin_supply_ratio",description:"Stablecoin Supply Ratio (SSR) from CryptoQuant or Glassnode. This requires a paid data subscription; no proxy is substituted.",schema:z.object({asset:z.string().default("BTC"),interval:z.string().default("1d"),limit:z.number().int().min(1).max(365).default(90)}),run:async(a,e)=>cryptoQuantRequired(e,"SSR",a)},
 {name:"exchange_netflow",description:"Exchange netflow from CryptoQuant or Glassnode. Requires provider entitlement; no inferred flows are returned.",schema:z.object({asset:z.string().default("BTC"),exchange:z.string().default("all_exchange"),interval:z.string().default("1d"),limit:z.number().int().min(1).max(365).default(90)}),run:async(a,e)=>cryptoQuantRequired(e,"exchange netflow",a)},
 {name:"etf_flows",description:"US spot Bitcoin/Ether ETF daily flows from Farside or a configured institutional data provider.",schema:z.object({asset:z.enum(["BTC","ETH"]).default("BTC"),start_date:z.string().optional(),end_date:z.string().optional()}),run:async(a,e)=>farsideRequired(e,"ETF flows",a)},
 {name:"spot_perpetual_volume_ratio",description:"Spot-to-perpetual volume ratio using supported exchange-reported 24h spot and derivatives turnover. Returns only venues with both values.",schema:z.object({symbol:symbolSchema.default(DEFAULT_SYMBOL)}),run:async(a)=>{const [spot,perp]=await Promise.all([getJson(`https://api.binance.com/api/v3/ticker/24hr?symbol=${a.symbol}`),getJson(`https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=${a.symbol}`)]);const s=Number(spot.quoteVolume),p=Number(perp.quoteVolume);return {symbol:a.symbol,spot_quote_volume:s,perpetual_quote_volume:p,spot_perp_ratio:s/p,source:"Binance 24h ticker endpoints"};}},
 {name:"stablecoin_inflows",description:"Stablecoin exchange inflows from on-chain analytics provider. Requires a paid data API; no chain-level estimate is fabricated.",schema:z.object({asset:z.enum(["USDT","USDC"]).default("USDT"),network:z.string().optional(),interval:z.string().default("1d")}),run:async(a,e)=>cryptoQuantRequired(e,"stablecoin exchange inflows",a)},
 {name:"coinbase_spot_volume",description:"Coinbase Exchange 24h spot volume for the selected USD product.",schema:z.object({symbol:symbolSchema.default("BTCUSDT")}),run:async(a)=>ticker("coinbase",a.symbol)},
 {name:"orderbook_imbalance_alert",description:"Evaluate live L2 bid/ask notional imbalance against a caller-specified threshold; emits an alert only from current book data.",schema:z.object({symbol:symbolSchema.default(DEFAULT_SYMBOL),exchange:z.enum(EXCHANGES).default("binance"),limit:z.number().int().min(5).max(1000).default(50),threshold:z.number().min(0.01).max(0.99).default(0.2)}),run:async(a)=>{const b=await orderbook(a.exchange,a.symbol,a.limit);return {...b,threshold:a.threshold,alert:Math.abs(Number(b.imbalance))>=a.threshold,direction:Number(b.imbalance)>0?"bid_dominant":"ask_dominant"};}},
 {name:"liquidation_price_calculator",description:"Calculate approximate isolated-margin liquidation price for a linear USDT-margined position. Excludes venue-specific maintenance tiers, fees and funding unless supplied.",schema:z.object({side:z.enum(["long","short"]),entry_price:z.number().positive(),quantity:z.number().positive(),leverage:z.number().positive().max(125),maintenance_margin_rate:z.number().min(0).max(0.2).default(0.005),extra_margin_usdt:z.number().min(0).default(0)}),run:async(a)=>{const notional=a.entry_price*a.quantity;const wallet=notional/a.leverage+a.extra_margin_usdt;const mm=notional*a.maintenance_margin_rate;const price=a.side==="long"?(notional-wallet+mm)/(a.quantity*(1-a.maintenance_margin_rate)):(notional+wallet-mm)/(a.quantity*(1+a.maintenance_margin_rate));return {estimated_liquidation_price:price,side:a.side,notional,initial_margin:notional/a.leverage,extra_margin_usdt:a.extra_margin_usdt,maintenance_margin_rate:a.maintenance_margin_rate,warning:"Approximation only. Confirm the exchange's tiered maintenance margin, close-fee, funding and cross/isolated rules before execution."};}},
 {name:"max_pain_levels",description:"Options max-pain calculation requires current options open interest and strike data from an options venue/provider.",schema:z.object({asset:z.string().default("BTC"),expiry:z.string().optional(),exchange:z.string().default("Deribit")}),run:async(a)=>{throw new ProviderError("OPTIONS_DATA_PROVIDER_UNAVAILABLE","No authenticated options-chain adapter is configured. Max-pain is unavailable rather than inferred from spot/perpetual data.",a.exchange,"Configure an options data API and implement its licensed chain endpoint.");}},
 {name:"paper_trade_backtest",description:"Run a basic long/short paper backtest on live historical OHLCV fetched from Binance; no orders are sent and no future data is used.",schema:z.object({symbol:symbolSchema.default(DEFAULT_SYMBOL),interval:z.enum(["5m","15m","1h","4h","1d"]).default("1h"),limit:z.number().int().min(50).max(1000).default(300),fast_ema:z.number().int().min(2).max(100).default(9),slow_ema:z.number().int().min(3).max(300).default(21),fee_bps:z.number().min(0).max(100).default(5)}),run:async(a)=>{if(a.fast_ema>=a.slow_ema)throw new ProviderError("INVALID_STRATEGY","fast_ema must be less than slow_ema");const cs=await candles("binance",a.symbol,a.interval,a.limit);const ema=(arr:number[],n:number)=>{const k=2/(n+1);let v=arr[0];return arr.map((x,i)=>v=i===0?x:x*k+v*(1-k));};const closes=cs.map(x=>x.close),f=ema(closes,a.fast_ema),s=ema(closes,a.slow_ema);let pos=0,entry=0,ret=0,trades=0;for(let i=1;i<closes.length;i++){const sig=f[i]>s[i]?1:-1;if(pos&&sig!==pos){ret+=pos*(closes[i]-entry)/entry-a.fee_bps/10000;trades++;pos=0;}if(!pos){pos=sig;entry=closes[i];}}if(pos){ret+=pos*(closes.at(-1)!-entry)/entry-a.fee_bps/10000;trades++;}return {symbol:a.symbol,interval:a.interval,bars:cs.length,fast_ema:a.fast_ema,slow_ema:a.slow_ema,fee_bps:a.fee_bps,return_pct:ret*100,closed_trades:trades,mode:"paper_backtest_only",source:"Binance public historical OHLCV",limitations:["No slippage model","No funding or borrow costs","No intrabar fills","Not investment advice"]};}},
 {name:"pnl_sats_converter",description:"Convert a BTC-denominated PnL or amount into satoshis using exact BTC unit conversion; optional live USD valuation uses Binance BTCUSDT ticker.",schema:z.object({btc_amount:z.number(),include_usd_value:z.boolean().default(false)}),run:async(a)=>{const sats=a.btc_amount*100_000_000;let usd:any=null;if(a.include_usd_value){const t=await ticker("binance","BTCUSDT");usd=a.btc_amount*Number(t.price);}return {btc:a.btc_amount,satoshis:sats,usd_value:usd};}},
 {name:"macro_dashboard",description:"DXY, US 10Y yield, VIX, WTI and Brent macro dashboard. Requires configured licensed market-data source; no guessed or delayed placeholder values.",schema:z.object({symbols:z.array(z.string()).default(["DXY","US10Y","VIX","WTI","BRENT"])}),run:async(a,e)=>macroRequired(e,"macro dashboard",a)},
 {name:"economic_calendar",description:"Upcoming Fed, CPI and macro releases. Requires configured calendar provider credentials.",schema:z.object({from_date:z.string().optional(),to_date:z.string().optional(),country:z.string().default("US")}),run:async(a,e)=>macroRequired(e,"economic calendar",a)},
 {name:"security_geopolitical_status",description:"Combined Binance incident/security status and geopolitical conflict-risk status. Requires configured verified news/status feeds; never infers an incident from social chatter.",schema:z.object({assets:z.array(z.string()).default(["Binance","BTC","ETH"]),lookback_hours:z.number().int().min(1).max(168).default(24)}),run:async(a,e)=>macroRequired(e,"security and geopolitical status",a)},
];

async function buildTenCharts(symbol:string, interval:string, limit:number, env:Env):Promise<Record<string,unknown>> {
  const chart = async (fn:()=>Promise<unknown>) => { try { return { status:"available", series: await fn() }; } catch(e) { return { status:"unavailable", error:serializeError(e) }; } };
  const candleSeries = async()=>candles("binance",symbol,interval,limit);
  const charts:Record<string,unknown>={};
  const jobs:Record<string,()=>Promise<unknown>>={
    price_volume:candleSeries,
    cvd:async()=>tradesCvd("binance",symbol,Math.min(limit,1000)),
    orderbook_depth:async()=>orderbook("binance",symbol,50),
    funding_by_exchange:async()=>{const r:any={};for(const x of ["binance","bybit","okx","hyperliquid"] as const){try{r[x]=await funding(x,symbol);}catch(e){r[x]={error:serializeError(e)};}}return r;},
    open_interest_by_exchange:async()=>{const r:any={};for(const x of ["binance","bybit","okx","hyperliquid"] as const){try{r[x]=await openInterest(x,symbol);}catch(e){r[x]={error:serializeError(e)};}}return r;},
    liquidation_levels:async()=>coinglassRequired(env,"liquidation levels",{symbol}),
    volume_profile:async()=>{const cs=await candleSeries() as any[];const lo=Math.min(...cs.map(x=>x.low)),hi=Math.max(...cs.map(x=>x.high)),n=40,step=(hi-lo)/n;if(!(step>0))throw new ProviderError("INSUFFICIENT_MARKET_DATA","Cannot build volume profile");const bins=Array.from({length:n},(_,i)=>({price_low:lo+i*step,price_high:lo+(i+1)*step,volume:0}));for(const c of cs){const i=Math.max(0,Math.min(n-1,Math.floor(((c.high+c.low+c.close)/3-lo)/step)));bins[i].volume+=c.volume;}return {methodology:"OHLCV typical-price approximation",bins};},
    anchored_vwap:async()=>{const cs=await candleSeries() as any[];let pv=0,v=0;for(const c of cs){pv+=((c.high+c.low+c.close)/3)*c.volume;v+=c.volume;}if(!v)throw new ProviderError("INSUFFICIENT_MARKET_DATA","No volume for VWAP");return {vwap:pv/v,anchor_time_ms:cs[0]?.time,methodology:"OHLCV typical-price approximation"};},
    premium_by_exchange:async()=>{const ref=await ticker("binance",symbol),r:any={reference:ref};for(const x of ["coinbase","bybit","okx"] as const){try{const t=await ticker(x,symbol);r[x]={...t,premium_pct:(Number(t.price)-Number(ref.price))/Number(ref.price)*100};}catch(e){r[x]={error:serializeError(e)};}}return r;},
    long_short_positioning:async()=>getJson(`https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=${symbol}&period=1h&limit=${Math.min(limit,500)}`)
  };
  await Promise.all(Object.entries(jobs).map(async([name,fn])=>{charts[name]=await chart(fn);}));
  return {chart_count:10,generated_at:new Date().toISOString(),charts};
}

function serializeError(e:unknown){if(e instanceof ProviderError)return {code:e.code,message:e.message,provider:e.provider??null,remediation:e.remediation??null};return {code:"UPSTREAM_ERROR",message:"The provider request could not be completed."};}
function unavailable(provider:string,metric:string,keyName:string){throw new ProviderError("PROVIDER_CREDENTIAL_MISSING",`${metric} is unavailable: ${provider} credentials are not configured. No mock, cached, or substitute value is returned.`,provider,`Configure Worker secret ${keyName}; then validate the provider's current API entitlement and endpoint.`);}
async function coinglassGet(env:Env,path:string,params:Record<string,string|number|undefined>={}):Promise<any>{
  const token=requireKey(env,"COINGLASS_API_KEY","CoinGlass");
  const url=new URL(path,"https://open-api-v4.coinglass.com");
  for(const [key,value] of Object.entries(params)) if(value!==undefined) url.searchParams.set(key,String(value));
  const response=await fetch(url.toString(),{method:"GET",headers:{accept:"application/json","CG-API-KEY":token},signal:AbortSignal.timeout(12_000)});
  const max=Number(response.headers.get("API-KEY-MAX-LIMIT")||0);
  const used=Number(response.headers.get("API-KEY-USE-LIMIT")||0);
  const body=await response.text();
  if(body.length>2_000_000) throw new ProviderError("UPSTREAM_RESPONSE_TOO_LARGE","CoinGlass response exceeded the permitted size.","CoinGlass");
  if(!response.ok) throw new ProviderError(response.status===401?"COINGLASS_AUTH_FAILED":response.status===429?"COINGLASS_RATE_LIMIT":"COINGLASS_HTTP_ERROR",`CoinGlass returned HTTP ${response.status}.`,"CoinGlass",response.status===401?"Rotate/check the CoinGlass key and set COINGLASS_API_KEY as a Worker secret.":response.status===429?"Wait for the plan's rate-limit window; avoid automatic retries.":"Check CoinGlass endpoint availability and plan entitlement.");
  let payload:any; try{payload=JSON.parse(body);}catch{throw new ProviderError("INVALID_PROVIDER_RESPONSE","CoinGlass returned non-JSON content.","CoinGlass");}
  if(String(payload?.code)!=="0") throw new ProviderError("COINGLASS_API_ERROR",String(payload?.msg||"CoinGlass rejected the request."),"CoinGlass","Check the endpoint parameters and subscription entitlement.");
  return {provider:"CoinGlass API v4",data:payload.data,rate_limit:{max_per_minute:Number.isFinite(max)&&max>0?max:null,used_in_window:Number.isFinite(used)&&used>=0?used:null}};
}
async function coinglassRequired(env:Env,metric:string,params:Record<string,unknown>){
  if(metric==="liquidation heatmap"||metric==="historical liquidation heatmap"){
    const interval="4h";
    return coinglassGet(env,"/api/futures/liquidation/history",{
      exchange:String(params.exchange||"Binance"),symbol:String(params.symbol||"BTCUSDT"),interval,
      limit:Math.min(Number(params.limit||1000),1000),
      start_time:params.start_time as number|undefined,end_time:params.end_time as number|undefined
    }).then(result=>({...result,metric:"historical_pair_liquidations",interval,unit:"USD",methodology:"CoinGlass pair liquidation history; 4h minimum interval on Hobbyist plan",plan_note:"The Hobbyist tier supports this endpoint at intervals of 4h or longer."}));
  }
  if(!env.COINGLASS_API_KEY) unavailable("CoinGlass",metric,"COINGLASS_API_KEY");
  throw new ProviderError("PLAN_ENTITLEMENT_REQUIRED",`${metric} is not available on the CoinGlass Hobbyist tier.`,"CoinGlass","The liquidation price-level map endpoints require Professional or Enterprise access. Use historical pair liquidation data instead.");
}
async function cryptoQuantRequired(env:Env,metric:string,params:Record<string,unknown>){if(!env.CRYPTOQUANT_API_KEY&&!env.GLASSNODE_API_KEY)unavailable("CryptoQuant/Glassnode",metric,"CRYPTOQUANT_API_KEY or GLASSNODE_API_KEY");throw new ProviderError("PROVIDER_ADAPTER_NOT_VERIFIED",`${metric} has credentials configured but no verified endpoint adapter in this release.`,"CryptoQuant/Glassnode","Validate the exact metric endpoint and account entitlement before implementing the adapter.");}
async function farsideRequired(env:Env,metric:string,params:Record<string,unknown>){if(!env.FARSIDE_API_KEY)unavailable("Farside",metric,"FARSIDE_API_KEY");throw new ProviderError("PROVIDER_ADAPTER_NOT_VERIFIED",`${metric} has no verified Farside API contract in this release.`,"Farside","Confirm that your Farside plan exposes an API; otherwise configure a licensed ETF-flow data provider.");}
async function macroRequired(env:Env,metric:string,params:Record<string,unknown>){unavailable("Macro/news data provider",metric,"MACRO_DATA_API_KEY");}

function createServer(env:Env) {
  const server = new McpServer({ name: "crypto-intelligence", version: "0.1.0" });
  for (const tool of metricTools) {
    server.registerTool(tool.name, { description: tool.description, inputSchema: tool.schema }, async (args:any) => {
      const started=Date.now();
      audit("tool_started",{tool:tool.name});
      try {
        const result=ok(await tool.run(args,env));
        audit("tool_completed",{tool:tool.name,status:"ok",duration_ms:Date.now()-started});
        return result;
      } catch (e) {
        const result=fail(e);
        audit("tool_completed",{tool:tool.name,status:"error",duration_ms:Date.now()-started});
        return result;
      }
    });
  }
  // Ten chart series are delivered together by market_snapshot and dedicated metric tools:
  // price/volume, CVD, order-book depth, funding, OI, liquidation levels, VPVR,
  // anchored VWAP, premium, and long/short positioning. Each series carries its own
  // source/methodology and may be unavailable independently; no synthetic chart is emitted.
  return server;
}

function constantTimeEqual(a:string,b:string):boolean {
  const enc=new TextEncoder();const x=enc.encode(a),y=enc.encode(b);let diff=x.length^y.length;const n=Math.max(x.length,y.length);for(let i=0;i<n;i++)diff|=(x[i]??0)^(y[i]??0);return diff===0;
}

async function sha256Hex(value:string):Promise<string>{
  const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(v=>v.toString(16).padStart(2,"0")).join("");
}

function audit(event:string, fields:Record<string,unknown> = {}){
  // Never pass authorization headers, tokens, request bodies, query strings, or provider payloads here.
  console.log(JSON.stringify({component:"crypto-intelligence-mcp",event,at:new Date().toISOString(),...fields}));
}

function secureResponse(response:Response):Response{
  const headers=new Headers(response.headers);
  headers.set("cache-control","no-store, no-cache, must-revalidate");
  headers.set("pragma","no-cache");
  headers.set("x-content-type-options","nosniff");
  headers.set("referrer-policy","no-referrer");
  headers.set("strict-transport-security","max-age=31536000; includeSubDomains");
  headers.delete("server");
  return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
}

export default {
  async fetch(request:Request, env:Env, ctx:ExecutionContext):Promise<Response> {
    const started=Date.now();
    const url=new URL(request.url);
    const requestId=crypto.randomUUID();
    if(url.pathname==="/health"){
      return secureResponse(Response.json({service:"crypto-intelligence-mcp",status:"ok",tools:metricTools.length,exchanges:EXCHANGES,charts:10,auth_required:true}));
    }
    if(url.pathname!==(env.MCP_ROUTE||"/mcp"))return secureResponse(new Response("Not found",{status:404}));
    if(!["GET","POST"].includes(request.method)){
      audit("request_rejected",{requestId,reason:"method_not_allowed",method:request.method});
      return secureResponse(new Response("Method not allowed",{status:405,headers:{allow:"GET, POST"}}));
    }
    if(request.method==="POST") {
      const contentType=request.headers.get("content-type")||"";
      if(!/^application\/json(?:\s*;|$)/i.test(contentType)){
        audit("request_rejected",{requestId,reason:"unsupported_media_type"});
        return secureResponse(new Response("Content-Type must be application/json",{status:415}));
      }
      const declared=Number(request.headers.get("content-length")||0);
      if(declared>MAX_MCP_BODY_BYTES){
        audit("request_rejected",{requestId,reason:"body_too_large",bytes:declared});
        return secureResponse(new Response("Request body too large",{status:413}));
      }
      const body=await request.clone().arrayBuffer();
      if(body.byteLength>MAX_MCP_BODY_BYTES){
        audit("request_rejected",{requestId,reason:"body_too_large",bytes:body.byteLength});
        return secureResponse(new Response("Request body too large",{status:413}));
      }
    }
    const ip=request.headers.get("cf-connecting-ip")||"unknown";
    if(!env.PREAUTH_RATE_LIMITER){
      audit("security_configuration_error",{requestId,reason:"preauth_limiter_missing"});
      return secureResponse(Response.json({error:{code:"RATE_LIMIT_NOT_CONFIGURED",message:"Security rate limiter is not configured."}},{status:503}));
    }
    let preauth:{success:boolean};
    try { preauth=await env.PREAUTH_RATE_LIMITER.limit({key:ip}); }
    catch {
      audit("security_configuration_error",{requestId,reason:"preauth_limiter_unavailable"});
      return secureResponse(Response.json({error:{code:"RATE_LIMIT_UNAVAILABLE",message:"Security rate limiter is unavailable."}},{status:503}));
    }
    if(!preauth.success){
      audit("rate_limited",{requestId,stage:"preauth"});
      return secureResponse(new Response("Too many requests",{status:429,headers:{"retry-after":"60"}}));
    }
    if(!env.AUTH_TOKEN||env.AUTH_TOKEN.length<32){
      audit("security_configuration_error",{requestId,reason:"auth_token_missing_or_weak"});
      return secureResponse(Response.json({error:{code:"AUTH_NOT_CONFIGURED",message:"A strong AUTH_TOKEN secret must be configured."}},{status:503}));
    }
    const auth=request.headers.get("authorization")||"";
    const supplied=auth.startsWith("Bearer ")?auth.slice(7):"";
    if(!supplied||!constantTimeEqual(supplied,env.AUTH_TOKEN)){
      audit("authentication_failed",{requestId});
      return secureResponse(new Response("Unauthorized",{status:401,headers:{"www-authenticate":"Bearer"}}));
    }
    if(!env.AUTH_RATE_LIMITER){
      audit("security_configuration_error",{requestId,reason:"auth_limiter_missing"});
      return secureResponse(Response.json({error:{code:"RATE_LIMIT_NOT_CONFIGURED",message:"Authenticated rate limiter is not configured."}},{status:503}));
    }
    const tokenHash=await sha256Hex(supplied);
    let authenticated:{success:boolean};
    try { authenticated=await env.AUTH_RATE_LIMITER.limit({key:tokenHash}); }
    catch {
      audit("security_configuration_error",{requestId,reason:"auth_limiter_unavailable"});
      return secureResponse(Response.json({error:{code:"RATE_LIMIT_UNAVAILABLE",message:"Security rate limiter is unavailable."}},{status:503}));
    }
    if(!authenticated.success){
      audit("rate_limited",{requestId,stage:"authenticated"});
      return secureResponse(new Response("Too many requests",{status:429,headers:{"retry-after":"60"}}));
    }
    try {
      const handler=createMcpHandler(()=>createServer(env),{route:env.MCP_ROUTE||"/mcp",legacy:"stateless",responseMode:"auto",corsOptions:false});
      const response=await handler(request,env,ctx);
      audit("request_completed",{requestId,status:response.status,duration_ms:Date.now()-started});
      return secureResponse(response);
    } catch {
      audit("request_failed",{requestId,duration_ms:Date.now()-started});
      return secureResponse(Response.json({error:{code:"INTERNAL_ERROR",message:"The request could not be completed."}},{status:500}));
    }
  }
} satisfies ExportedHandler<Env>;

export const TOOL_CONTRACT_NAMES = metricTools.map(t=>t.name);
