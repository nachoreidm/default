import crypto from "node:crypto";
import { KrakenApiError } from "./kraken.js";

// READ-ONLY Kraken private API client. Deliberately ports only the
// read-only endpoints (Balance, OpenOrders, ClosedOrders, QueryOrders,
// Ledgers) from the live trading branch's kraken-private.ts - AddOrder
// and CancelOrder are NOT here, on purpose. This keeps this agent's
// "no execution capability anywhere in this codebase" property true at
// the Kraken layer too, not just the stock side: the API key this file
// expects only needs Query Funds / Query Open Orders & Trades / Query
// Closed Orders & Trades / Query Ledger Entries permissions on Kraken's
// side - no "Create & Modify Orders," no "Cancel/Close Orders," no
// "Withdraw Funds" - so even a fully compromised key or a bug in this
// file can only ever read, never place or move anything.
//
// Uses its own env var names (KRAKEN_READONLY_API_KEY/SECRET), distinct
// from the live trading branch's KRAKEN_API_KEY/SECRET, so the two are
// never confusable even though they could theoretically live in the same
// environment - this branch's key should be a different, separately-
// created Kraken API key with a strictly smaller permission set.
//
// Signing scheme ported verbatim from the live branch's kraken-
// private.ts (nonce + POST body -> SHA256 -> HMAC-SHA512 with the
// base64-decoded secret -> base64 API-Sign header) - that implementation
// was already confirmed correct against live Kraken via a validate:true
// AddOrder call on the live branch, so this is reusing proven signing
// logic, not new unverified code. The read-only endpoints below ARE new
// here and need their own live smoke test once KRAKEN_READONLY_API_KEY/
// SECRET exist.
const KRAKEN_API_BASE = "https://api.kraken.com";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new KrakenApiError(
      `Missing required environment variable ${name} - cannot authenticate with Kraken without it. See CLAUDE.md's credential-setup section for how to create a read-only key.`
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
  const apiKey = requireEnv("KRAKEN_READONLY_API_KEY");
  const apiSecret = requireEnv("KRAKEN_READONLY_API_SECRET");

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

// Asset code -> balance, as a decimal string (e.g. { "ZEUR": "1234.5678", "XLTC": "10.0000000000" }).
// Kraken omits zero-balance assets entirely rather than returning "0" -
// same quirk the live branch's liveCashEur() had to handle.
export type KrakenBalance = Record<string, string>;

export async function queryBalance(): Promise<KrakenBalance> {
  return krakenPrivateFetch<KrakenBalance>("/0/private/Balance");
}

export interface KrakenOrderInfo {
  status: "pending" | "open" | "closed" | "canceled" | "expired";
  opentm: number;
  closetm?: number;
  descr: { pair: string; type: string; ordertype: string; price: string; price2: string; order: string };
  vol: string;
  vol_exec: string;
  cost: string;
  fee: string;
  price: string;
  reason?: string;
  userref?: number;
}

export async function queryOpenOrders(): Promise<{ open: Record<string, KrakenOrderInfo> }> {
  return krakenPrivateFetch<{ open: Record<string, KrakenOrderInfo> }>("/0/private/OpenOrders");
}

// `start`: unix timestamp (seconds) - only orders closed at/after this
// time are returned. Defaults to the full history Kraken will return if
// omitted.
export async function queryClosedOrders(start?: number): Promise<{ closed: Record<string, KrakenOrderInfo> }> {
  const params: Record<string, string> = {};
  if (start !== undefined) params.start = String(start);
  return krakenPrivateFetch<{ closed: Record<string, KrakenOrderInfo> }>("/0/private/ClosedOrders", params);
}

export async function queryOrdersInfo(txids: string[]): Promise<Record<string, KrakenOrderInfo>> {
  return krakenPrivateFetch<Record<string, KrakenOrderInfo>>("/0/private/QueryOrders", {
    txid: txids.join(","),
  });
}

export interface KrakenLedgerEntry {
  refid: string;
  time: number;
  type: string; // "trade" | "deposit" | "withdrawal" | "transfer" | ...
  subtype: string;
  aclass: string;
  asset: string;
  amount: string;
  fee: string;
  balance: string;
}

// `start`: unix timestamp (seconds), same semantics as queryClosedOrders.
export async function queryLedgers(start?: number): Promise<{ ledger: Record<string, KrakenLedgerEntry> }> {
  const params: Record<string, string> = {};
  if (start !== undefined) params.start = String(start);
  return krakenPrivateFetch<{ ledger: Record<string, KrakenLedgerEntry> }>("/0/private/Ledgers", params);
}
