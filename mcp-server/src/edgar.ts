import type { InsiderTransaction, Institutional13FMention } from "./types.js";

// SEC EDGAR (data.sec.gov / www.sec.gov / efts.sec.gov) - all free, no API
// key. SEC's own fair-access policy requires a descriptive User-Agent
// identifying the requester (not a generic browser UA) - uses the
// account owner's email, exactly the legitimate purpose that header
// exists for (SEC's documented example format is "Sample Company
// AdminContact@sample.com").
const USER_AGENT = "MarketAdvisoryAgent/1.0 (contact: ignacio_reid@hotmail.com)";

export class EdgarApiError extends Error {}

async function edgarFetch(url: string): Promise<Response> {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, "Accept-Encoding": "identity" } });
  if (!res.ok) {
    throw new EdgarApiError(`SEC EDGAR HTTP ${res.status} for ${url}`);
  }
  return res;
}

let tickerCikCache: Map<string, string> | null = null;

// SEC publishes a single flat ticker->CIK mapping file, free, no key.
async function loadTickerCikMap(): Promise<Map<string, string>> {
  if (tickerCikCache) return tickerCikCache;
  const res = await edgarFetch("https://www.sec.gov/files/company_tickers.json");
  const body = (await res.json()) as Record<string, { cik_str: number; ticker: string; title: string }>;
  const map = new Map<string, string>();
  for (const entry of Object.values(body)) {
    map.set(entry.ticker.toUpperCase(), String(entry.cik_str).padStart(10, "0"));
  }
  tickerCikCache = map;
  return map;
}

export async function getCikForTicker(ticker: string): Promise<string> {
  const map = await loadTickerCikMap();
  const cik = map.get(ticker.toUpperCase());
  if (!cik) {
    throw new EdgarApiError(`No SEC CIK found for ticker "${ticker}" - check the symbol, or it may not be a US-listed issuer SEC tracks this way.`);
  }
  return cik;
}

// Best-effort structured extraction from a Form 4 XML document using
// regex on the known tag names (ownershipDocument schema) rather than a
// full XML parser - no xml-parsing dependency exists in this project yet,
// and Form 4's relevant fields are simple enough scalar values that this
// is a reasonable first pass. UNVERIFIED AGAINST A LIVE DOCUMENT as of
// this writing (sec.gov isn't allowlisted in this environment yet) - if
// a real filing's tags don't match, fields come back null rather than
// throwing, so a parsing miss shows up as a gap in the output, not a
// crash or a wrong number.
function extractTag(xml: string, tag: string): string | null {
  const match = xml.match(new RegExp(`<${tag}>\\s*<value>([^<]*)</value>`, "i")) ?? xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`, "i"));
  return match ? match[1].trim() : null;
}

async function parseForm4(accessionNoDashes: string, cik: string, filedAt: string, primaryDoc: string): Promise<InsiderTransaction | null> {
  const docUrl = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accessionNoDashes}/${primaryDoc}`;
  try {
    const res = await edgarFetch(docUrl);
    const xml = await res.text();
    const sharesRaw = extractTag(xml, "transactionShares");
    const priceRaw = extractTag(xml, "transactionPricePerShare");
    return {
      filed_at: filedAt,
      transaction_date: extractTag(xml, "transactionDate") ?? filedAt,
      insider_name: extractTag(xml, "rptOwnerName") ?? "unknown",
      insider_title: extractTag(xml, "officerTitle") ?? extractTag(xml, "reportingOwnerRelationship") ?? "unknown",
      transaction_code: extractTag(xml, "transactionCode") ?? "?",
      shares: sharesRaw ? Number(sharesRaw) : null,
      price_per_share: priceRaw ? Number(priceRaw) : null,
      acquired_or_disposed: (extractTag(xml, "transactionAcquiredDisposedCode") as "A" | "D" | null) ?? null,
      accession_number: accessionNoDashes,
      source_url: docUrl,
    };
  } catch {
    // Fails safe: a single unparseable filing is dropped from the list
    // rather than failing the whole insider-activity call.
    return null;
  }
}

// Returns the most recent Form 4 (insider buy/sell) filings for a
// ticker's issuer, parsed into structured transactions where possible.
// Form 4 is filed per-issuer (unlike 13F below), so this is a clean,
// ticker-centric, near-real-time signal - genuinely different from the
// 13F proxy, not just a second view of the same data.
export async function getInsiderActivity(ticker: string, limit = 10): Promise<InsiderTransaction[]> {
  const cik = await getCikForTicker(ticker);
  const res = await edgarFetch(`https://data.sec.gov/submissions/CIK${cik}.json`);
  const body = (await res.json()) as {
    filings: { recent: { form: string[]; accessionNumber: string[]; filingDate: string[]; primaryDocument: string[] } };
  };
  const { form, accessionNumber, filingDate, primaryDocument } = body.filings.recent;

  const form4Indices: number[] = [];
  for (let i = 0; i < form.length && form4Indices.length < limit; i++) {
    if (form[i] === "4") form4Indices.push(i);
  }

  const results = await Promise.all(
    form4Indices.map((i) => parseForm4(accessionNumber[i].replace(/-/g, ""), cik, filingDate[i], primaryDocument[i]))
  );
  return results.filter((r): r is InsiderTransaction => r !== null);
}

// 13F-HR filings are filed BY institutional managers listing ALL their
// holdings, not by the company itself - there's no clean per-issuer "who
// holds this stock and how did they change it" endpoint on EDGAR the way
// there is for Form 4. This uses EDGAR's full-text search across recent
// 13F-HR filings for the company name, which only tells you WHICH
// managers' filings mention the name somewhere in that filing - NOT a
// parsed, aggregated net-buy/net-sell figure. Treat this as a noisy
// "who's been filing near this name recently" proxy, never as "net
// institutional flow" - that would require fetching and parsing every
// matched manager's full holdings table (hundreds of XML rows each) to
// find the specific CUSIP and compare quarter-over-quarter, which this
// first build deliberately doesn't attempt. Also inherently laggy: 13F
// is filed up to 45 days after quarter-end, so "recent" here still means
// stale by real-world standards - must be labeled as such wherever this
// output reaches the daily report.
export async function getInstitutional13FMentions(companyName: string, limit = 10): Promise<Institutional13FMention[]> {
  const url = new URL("https://efts.sec.gov/LATEST/search-index");
  url.searchParams.set("q", `"${companyName}"`);
  url.searchParams.set("forms", "13F-HR");

  const res = await edgarFetch(url.toString());
  const body = (await res.json()) as {
    hits: { hits: Array<{ _source: { display_names: string[]; file_date: string; adsh: string; root_form: string } }> };
  };

  return (body.hits?.hits ?? []).slice(0, limit).map((h) => ({
    filer_name: h._source.display_names?.[0] ?? "unknown",
    filed_at: h._source.file_date,
    form_type: h._source.root_form,
    accession_number: h._source.adsh,
    source_url: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&filing=${h._source.adsh}`,
  }));
}
