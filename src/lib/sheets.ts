import { google } from "googleapis";
import type { InvoiceRow, CustomerDSO } from "./stripe";

const INR_PER_USD = 95;
const EUR_PER_USD = 1.17;

function toUsd(amount: number, currency: string): number {
  const c = (currency ?? "").toUpperCase();
  if (c === "INR") return amount / INR_PER_USD;
  if (c === "EUR") return amount * EUR_PER_USD;
  return amount;
}

function getAuth() {
  const jsonEnv = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (jsonEnv) {
    const creds = JSON.parse(jsonEnv);
    return new google.auth.JWT(creds.client_email, undefined, creds.private_key, ["https://www.googleapis.com/auth/spreadsheets"]);
  }
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const rawKey = process.env.GOOGLE_PRIVATE_KEY;
  if (!email || !rawKey) throw new Error("Set GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_SERVICE_ACCOUNT_EMAIL + GOOGLE_PRIVATE_KEY.");
  return new google.auth.JWT(email, undefined, rawKey.replace(/\\n/g, "\n"), ["https://www.googleapis.com/auth/spreadsheets"]);
}

export interface CustomerMeta { customer_name_sheet: string; domain: string; status: string; business: string; cs_email: string; }
export type CustomerMetaMap = Map<string, CustomerMeta>;

function findCol(headers: string[], aliases: string[]): number {
  return headers.findIndex(h => aliases.some(a => h.includes(a)));
}

export async function readCustomerMetadata(): Promise<CustomerMetaMap> {
  const sheetId = process.env.GOOGLE_BIZ_SHEET_ID ?? process.env.GOOGLE_SHEET_ID;
  if (!sheetId) throw new Error("Missing GOOGLE_SHEET_ID env var.");
  const tabName = process.env.GOOGLE_BIZ_TAB_NAME ?? "Customer Domain Name";
  const auth = getAuth();
  const sheets = google.sheets({ version: "v4", auth });
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: tabName });
  const rows = res.data.values ?? [];
  if (rows.length < 2) return new Map();
  const headers = rows[0].map((h: string) => String(h).toLowerCase().trim());
  const nameCol   = findCol(headers, ["customer name"]);
  const idCol     = findCol(headers, ["stripe customer id", "customer id", "stripe id"]);
  const domainCol = findCol(headers, ["domain"]);
  const statusCol = findCol(headers, ["status"]);
  const bizCol    = findCol(headers, ["business"]);
  const csCol     = findCol(headers, ["cs name", "cs email"]);
  if (idCol === -1) { console.warn("[readCustomerMetadata] No customer-ID column found."); return new Map(); }
  const map: CustomerMetaMap = new Map();
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const custId = String(row[idCol] ?? "").trim();
    if (!custId) continue;
    const raw = (c: number) => c >= 0 ? String(row[c] ?? "").trim() : "";
    const clean = (v: string) => ["#N/A","N/A","#VALUE!","#REF!"].includes(v) ? "" : v;
    map.set(custId, { customer_name_sheet: clean(raw(nameCol)), domain: clean(raw(domainCol)), status: clean(raw(statusCol)), business: clean(raw(bizCol)), cs_email: clean(raw(csCol)) });
  }
  return map;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function ensureTabExists(sheets: any, sheetId: string, tabName: string) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const exists = (meta.data.sheets ?? []).some((s: any) => s.properties?.title === tabName);
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({ spreadsheetId: sheetId, requestBody: { requests: [{ addSheet: { properties: { title: tabName } } }] } });
  }
}

export async function exportToSheets(invoices: InvoiceRow[], dso: CustomerDSO[]): Promise<{ url: string }> {
  const sheetId = process.env.GOOGLE_EXPORT_SHEET_ID ?? process.env.GOOGLE_SHEET_ID;
  if (!sheetId) throw new Error("Missing GOOGLE_EXPORT_SHEET_ID env var.");
  const auth = getAuth();
  const sheets = google.sheets({ version: "v4", auth });
  const TAB = "Outstanding Invoices";
  await ensureTabExists(sheets, sheetId, TAB);

  const dsoLookup = new Map<string, { dso_days: number; invoice_count: number }>();
  for (const d of dso) {
    dsoLookup.set(`${d.customer_id}::${d.account}`, { dso_days: d.invoice_count * 30, invoice_count: d.invoice_count });
  }

  interface CustRow { customer_name:string; customer_email:string; domain:string; customer_status:string; business:string; cs_email:string; account:string; b0_30:number; b31_60:number; b61_90:number; b90plus:number; total:number; invoice_count:number; dso_days:number; }
  const custMap = new Map<string, CustRow>();
  for (const inv of invoices) {
    const usd = toUsd(inv.amount_due, inv.currency);
    const key = `${inv.customer_id}::${inv.account}`;
    if (!custMap.has(key)) {
      const d = dsoLookup.get(key) ?? { dso_days: 0, invoice_count: 0 };
      custMap.set(key, { customer_name: inv.customer_name, customer_email: inv.customer_email, domain: inv.domain ?? "", customer_status: inv.customer_status ?? "", business: inv.business ?? "", cs_email: inv.cs_email ?? "", account: inv.account, b0_30:0, b31_60:0, b61_90:0, b90plus:0, total:0, invoice_count: d.invoice_count, dso_days: d.dso_days });
    }
    const c = custMap.get(key)!;
    c.total += usd;
    if (inv.aging_bucket === "0-30") c.b0_30 += usd;
    else if (inv.aging_bucket === "31-60") c.b31_60 += usd;
    else if (inv.aging_bucket === "61-90") c.b61_90 += usd;
    else c.b90plus += usd;
  }

  const rows = Array.from(custMap.values()).sort((a, b) => b.total - a.total);
  const fmt = (n: number) => Math.round(n * 100) / 100;
  const headers = ["Domain","Customer Name","Email","Account","Status","Business","CS Owner","0-30 Days (USD)","31-60 Days (USD)","61-90 Days (USD)","90+ Days (USD)","Total Outstanding (USD)","DSO (Days)","Invoice Count"];
  const dataRows = rows.map(r => [r.domain, r.customer_name, r.customer_email, r.account, r.customer_status, r.business, r.cs_email, fmt(r.b0_30), fmt(r.b31_60), fmt(r.b61_90), fmt(r.b90plus), fmt(r.total), r.dso_days, r.invoice_count]);
  const tot = rows.reduce((a,r) => ({ b0_30:a.b0_30+r.b0_30, b31_60:a.b31_60+r.b31_60, b61_90:a.b61_90+r.b61_90, b90plus:a.b90plus+r.b90plus, total:a.total+r.total }), {b0_30:0,b31_60:0,b61_90:0,b90plus:0,total:0});
  const totalsRow = ["TOTAL","","","","","","",fmt(tot.b0_30),fmt(tot.b31_60),fmt(tot.b61_90),fmt(tot.b90plus),fmt(tot.total),"",""];
  const timestamp = new Date().toISOString().replace("T"," ").slice(0,19);
  const allValues = [[`Last updated: ${timestamp}`, ...Array(headers.length-1).fill("")], headers, ...dataRows, totalsRow];

  await sheets.spreadsheets.values.clear({ spreadsheetId: sheetId, range: TAB });
  await sheets.spreadsheets.values.update({ spreadsheetId: sheetId, range: `${TAB}!A1`, valueInputOption: "USER_ENTERED", requestBody: { values: allValues } });
  return { url: `https://docs.google.com/spreadsheets/d/${sheetId}` };
}
