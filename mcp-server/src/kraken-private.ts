import crypto from "node:crypto";
import { KrakenApiError } from "./kraken.js";

// Kraken's private REST API lives under the same domain as the public API
// (already the only domain allowlisted in this environment's network
// policy), just under /0/private/ instead of /0/public/, and requires two
// things on every request: a strictly-increasing `nonce` in the POST body,
// and an API-Sign header computed as
//   base64( HMAC-SHA512( base64_decode(secret), path + SHA256(nonce + postdata) ) )
// This is Kraken's long-stable, widely-implemented signing scheme - unable
// to double-check the exact spec text against Kraken's own docs from this
// environment (network policy blocks everything except api.kraken.com), so
// the real correctness gate is a live `validate: true` AddOrder call once
// credentials exist: Kraken rejects a wrong signature outright, so that
// call can't silently pass if this is wrong.
const KRAKEN_API_BASE = "https://api.kraken.com";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new KrakenApiError(
      `Missing required environment variable ${name} - live trading cannot authenticate with Kraken without it.`
    );
  }
  return v;
}

function sign(path: string, postData: string, nonce: string, secret: string): string {
  const secretBuffer = Buffer.from(secret, "base64");
  const sha256Digest = crypto.createHash("sha256").update(nonce + postData).digest();
  const hmac = crypto.createHmac("sha512", secretBuffer);
  hmac.update(Buffer.concat([Buffer.from(path, "utf-8"), sha256Digest]));
  return hmac.digest("base64");
}

async function krakenPrivateFetch<T>(path: string, params: Record<string, string> = {}): Promise<T> {
  const apiKey = requireEnv("KRAKEN_API_KEY");
  const apiSecret = requireEnv("KRAKEN_API_SECRET");

  const nonce = Date.now().toString();
  const body = new URLSearchParams({ nonce, ...params });
  const postData = body.toString();
  const signature = sign(path, postData, nonce, apiSecret);

  const res = await fetch(`${KRAKEN_API_BASE}${path}`, {
    method: "POST",
    headers: {
      "API-Key": apiKey,
      "API-Sign": signature,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: postData,
  });
  if (!res.ok) {
    throw new KrakenApiError(`Kraken private API HTTP ${res.status} for ${path}`);
  }
  const json = (await res.json()) as { error: string[]; result: T };
  if (json.error && json.error.length > 0) {
    throw new KrakenApiError(`Kraken private API error for ${path}: ${json.error.join(", ")}`);
  }
  return json.result;
}

export type KrakenOrderType =
  | "market"
  | "limit"
  | "stop-loss"
  | "stop-loss-limit"
  | "take-profit"
  | "take-profit-limit";

export interface AddOrderParams {
  pair: string; // Kraken pair code, e.g. "XBTEUR"
  type: "buy" | "sell";
  ordertype: KrakenOrderType;
  volume: string; // decimal string, e.g. "0.01234500"
  price?: string; // required for limit/stop-loss/take-profit order types
  price2?: string; // required for *-limit order types (the limit price once the stop triggers)
  // Attaches a contingent order that activates only once this order fills
  // (Kraken-managed one-triggers-the-other). Needs confirming against a
  // real AddOrder response before portfolio-live.ts relies on it for the
  // take-profit leg - see the plan's flagged verification item.
  close_ordertype?: KrakenOrderType;
  close_price?: string;
  userref?: string; // integer as string, for tagging/lookup
  validate?: boolean; // true = dry-run, authenticates and validates but places nothing
}

export interface AddOrderResult {
  descr: { order: string; close?: string };
  txid?: string[]; // absent when validate: true
}

export async function addOrder(params: AddOrderParams): Promise<AddOrderResult> {
  const body: Record<string, string> = {
    pair: params.pair,
    type: params.type,
    ordertype: params.ordertype,
    volume: params.volume,
  };
  if (params.price !== undefined) body.price = params.price;
  if (params.price2 !== undefined) body.price2 = params.price2;
  if (params.close_ordertype !== undefined) body["close[ordertype]"] = params.close_ordertype;
  if (params.close_price !== undefined) body["close[price]"] = params.close_price;
  if (params.userref !== undefined) body.userref = params.userref;
  if (params.validate) body.validate = "true";
  return krakenPrivateFetch<AddOrderResult>("/0/private/AddOrder", body);
}

export interface CancelOrderResult {
  count: number;
  pending?: boolean;
}

export async function cancelOrder(txid: string): Promise<CancelOrderResult> {
  return krakenPrivateFetch<CancelOrderResult>("/0/private/CancelOrder", { txid });
}

// Asset code -> balance, as a decimal string (e.g. { "ZEUR": "1234.5678", "SUI": "10.0000000000" }).
export type KrakenBalance = Record<string, string>;

export async function queryBalance(): Promise<KrakenBalance> {
  return krakenPrivateFetch<KrakenBalance>("/0/private/Balance");
}

export interface KrakenOrderInfo {
  status: "pending" | "open" | "closed" | "canceled" | "expired";
  opentm: number;
  closetm?: number;
  descr: { pair: string; type: string; ordertype: string; price: string; price2: string; order: string };
  vol: string; // ordered volume
  vol_exec: string; // executed volume
  cost: string; // total cost of the executed volume, in quote currency
  fee: string; // total fee, in quote currency
  price: string; // average fill price
  reason?: string; // e.g. why an order was canceled/expired
  userref?: number;
}

export async function queryOpenOrders(): Promise<{ open: Record<string, KrakenOrderInfo> }> {
  return krakenPrivateFetch<{ open: Record<string, KrakenOrderInfo> }>("/0/private/OpenOrders");
}

// `start`: unix timestamp (seconds) - only orders closed at/after this time
// are returned. Used for reconciliation: pass the last cycle's check time
// to find only what changed since then, rather than the full history.
export async function queryClosedOrders(start?: number): Promise<{ closed: Record<string, KrakenOrderInfo> }> {
  const params: Record<string, string> = {};
  if (start !== undefined) params.start = String(start);
  return krakenPrivateFetch<{ closed: Record<string, KrakenOrderInfo> }>("/0/private/ClosedOrders", params);
}

// Looks up specific orders by txid regardless of open/closed state - used
// right after placing an order to read back its real fill price/fee once
// it completes (AddOrder itself only confirms placement, not the fill).
export async function queryOrdersInfo(txids: string[]): Promise<Record<string, KrakenOrderInfo>> {
  return krakenPrivateFetch<Record<string, KrakenOrderInfo>>("/0/private/QueryOrders", {
    txid: txids.join(","),
  });
}
