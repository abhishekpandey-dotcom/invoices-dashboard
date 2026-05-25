import { google } from "googleapis";
import type { InvoiceRow, CustomerDSO } from "./stripe";

interface InvoiceRowWithUsd extends InvoiceRow { amount_usd: number; }
interface CustomerDSOWithUsd extends CustomerDSO { total_outstanding_usd: number; dso_days: number; }

function getAuth() {
  const jsonEnv = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (jsonEnv) {
    const creds = JSON.parse(jsonEnv);
    return new google.auth.JWT(
      creds.client_email, undefined, creds.private_key,
      ["https://www.googleapis.com/auth/spreadsheets"]
    );
  }
  const email  = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const rawKey = process.env.GOOGLE_PRIVATE_KEY;
  if (!email || !rawKey) throw new Error("Set GOOGLE_SERVICE_ACCOUNT_JSON.");
  return new google.auth.JWT(
    email, undefined, rawKey.replace(/\\n/g, "\n"),
    ["https://www.googleapis.com/auth/spreadsheets"]
  );
}

export interface CustomerMeta { customer_name_sheet:string; domain:string; status:string; business:string; cs_email:string; }
export type CustomerMetaMap = Map<string, CustomerMeta>;

function findCol(headers: string[], aliases: string[]): number {
  return headers.findIndex(h => aliases.some(a => h.includes(a)));
}

export async function readCustomerMetadata(): Promise<CustomerMetaMap> {
  const sheetId = process.env.GOOGLE_BIZ_SHEET_ID ?? process.env.GOOGLE_SHEET_ID;
  if (!sheetId) throw new Error("Missing GOOGLE_SHEET_ID env var.");
  const tabName = process.env.GOOGLE_BIZ_TAB_NAME ?? "Customer Domain Name";
  const auth    = getAuth();
  const sheets  = google.sheets({ version: "v4", auth });
  const res     = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: tabName });
  const rows    = res.data.values ?? [];
  if (rows.length < 2) return new Map();

  const headers   = rows[0].map((h: string) => String(h).toLowerCase().trim());
  const nameCol   = findCol(headers, ["customer name"]);
  const idCol     = findCol(headers, ["stripe customer id", "customer id", "stripe id"]);
  const domainCol = findCol(headers, ["domain"]);
  const statusCol = findCol(headers, ["status"]);
  const bizCol    = findCol(headers, ["business"]);
  const csCol     = findCol(headers, ["cs name", "cs email", "ae name", "ae email"]);

  if (idCol === -1) {
    console.warn(`[readCustomerMetadata] No customer-ID column. Headers: ${headers.join(", ")}`);
    return new Map();
  }

  const map: CustomerMetaMap = new Map();
  for (let i = 1; i < rows.length; i++) {
    const row    = rows[i];
    const custId = String(row[idCol] ?? "").trim();
    if (!custId) continue;
    const raw   = (c: number) => c >= 0 ? String(row[c] ?? "").trim() : "";
    const clean = (v: string) => ["#N/A","N/A","#VALUE!","#REF!"].includes(v) ? "" : v;
    map.set(custId, {
      customer_name_sheet: clean(raw(nameCol)),
      domain:              clean(raw(domainCol)),
      status:              clean(raw(statusCol)),
      business:            clean(raw(bizCol)),
      cs_email:            clean(raw(csCol)),
    });
  }
  return map;
}

async function ensureTabsExist(sheets: ReturnType<typeof google.sheets>, spreadsheetId: string, tabNames: string[]) {
  const meta     = await sheets.spreadsheets.get({ spreadsheetId });
  const existing = new Set((meta.data.sheets ?? []).map(s => s.properties?.title ?? ""));
  const toCreate = tabNames.filter(t => !existing.has(t));
  if (toCreate.length === 0) return;
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: toCreate.map(title => ({ addSheet: { properties: { title } } })) },
  });
}

export async function exportToSheets(
  invoices: InvoiceRowWithUsd[],
  dso: CustomerDSOWithUsd[]
): Promise<{ url: string }> {
  const sheetId = process.env.GOOGLE_EXPORT_SHEET_ID ?? process.env.GOOGLE_SHEET_ID;
  if (!sheetId) throw new Error("Missing GOOGLE_SHEET_ID env var.");

  const auth   = getAuth();
  const sheets = google.sheets({ version: "v4", auth });

  await ensureTabsExist(sheets, sheetId, ["Outstanding Invoices"]);

  const timestamp = new Date().toISOString().replace("T", " ").slice(0, 19);

  // Build customer-wise rows from invoices (same logic as dashboard)
  interface CustAgg {
    customer_name: string; customer_email: string; domain: string;
    customer_status: string; business: string; cs_email: string;
    account: string; b0_30: number; b31_60: number; b61_90: number;
    b90plus: number; total: number; invoice_count: number;
  }
  const custMap = new Map<string, CustAgg>();
  for (const inv of invoices) {
    const key = `${inv.account}::${inv.customer_id}`;
    if (!custMap.has(key)) custMap.set(key, {
      customer_name: inv.customer_name, customer_email: inv.customer_email,
      domain: inv.domain, customer_status: inv.customer_status,
      business: inv.business, cs_email: inv.cs_email, account: inv.account,
      b0_30: 0, b31_60: 0, b61_90: 0, b90plus: 0, total: 0, invoice_count: 0,
    });
    const c = custMap.get(key)!;
    c.total += inv.amount_usd; c.invoice_count++;
    if (inv.aging_bucket === "0-30")       c.b0_30   += inv.amount_usd;
    else if (inv.aging_bucket === "31-60") c.b31_60  += inv.amount_usd;
    else if (inv.aging_bucket === "61-90") c.b61_90  += inv.amount_usd;
    else                                   c.b90plus += inv.amount_usd;
  }

  // DSO from the already-correctly-calculated dso array
  const dsoMap = new Map(dso.map(d => [`${d.account}::${d.customer_id}`, d.dso_days]));

  const fmt = (n: number) => Math.round(n * 100) / 100;

  const headers = [
    "Domain", "Customer Name", "Email", "Account", "Status", "Business", "CS Owner",
    "0-30 Days (USD)", "31-60 Days (USD)", "61-90 Days (USD)", "90+ Days (USD)",
    "Total Outstanding (USD)", "DSO (Days)", "Invoice Count",
  ];

  const dataRows = Array.from(custMap.entries())
    .map(([key, c]) => [
      c.domain || "", c.customer_name, c.customer_email, c.account,
      c.customer_status || "", c.business || "", c.cs_email || "",
      fmt(c.b0_30), fmt(c.b31_60), fmt(c.b61_90), fmt(c.b90plus),
      fmt(c.total), dsoMap.get(key) ?? c.invoice_count * 30, c.invoice_count,
    ])
    .sort((a, b) => (b[11] as number) - (a[11] as number));

  const totals = [
    "TOTAL", "", "", "", "", "", "",
    fmt(dataRows.reduce((s, r) => s + (r[7] as number), 0)),
    fmt(dataRows.reduce((s, r) => s + (r[8] as number), 0)),
    fmt(dataRows.reduce((s, r) => s + (r[9] as number), 0)),
    fmt(dataRows.reduce((s, r) => s + (r[10] as number), 0)),
    fmt(dataRows.reduce((s, r) => s + (r[11] as number), 0)),
    "", dataRows.reduce((s, r) => s + (r[13] as number), 0),
  ];

  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: "Outstanding Invoices!A1",
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [
        [`Last updated: ${timestamp} · ${dataRows.length} customers`, ...Array(headers.length - 1).fill("")],
        headers,
        ...dataRows,
        totals,
      ],
    },
  });

  return { url: `https://docs.google.com/spreadsheets/d/${sheetId}` };
}
