import { google } from "googleapis";
import type { InvoiceRow, CustomerDSO } from "./stripe";

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
  if (!email || !rawKey) throw new Error("Set GOOGLE_SERVICE_ACCOUNT_JSON (or GOOGLE_SERVICE_ACCOUNT_EMAIL + GOOGLE_PRIVATE_KEY).");
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
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const existing = new Set((meta.data.sheets ?? []).map(s => s.properties?.title ?? ""));
  const toCreate = tabNames.filter(t => !existing.has(t));
  if (toCreate.length === 0) return;
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: toCreate.map(title => ({ addSheet: { properties: { title } } })),
    },
  });
}

export async function exportToSheets(invoices: InvoiceRow[], dso: CustomerDSO[]): Promise<{ url: string }> {
  const sheetId = process.env.GOOGLE_EXPORT_SHEET_ID ?? process.env.GOOGLE_SHEET_ID;
  if (!sheetId) throw new Error("Missing GOOGLE_SHEET_ID env var.");

  const auth   = getAuth();
  const sheets = google.sheets({ version: "v4", auth });

  // Create Invoices and DSO tabs if they don't exist yet
  await ensureTabsExist(sheets, sheetId, ["Invoices", "DSO"]);

  const timestamp = new Date().toISOString().replace("T", " ").slice(0, 19);

  const invoiceHeaders = [
    "Account","Invoice #","Customer Name","Customer Email","Stripe Customer ID",
    "Domain","Status","Business","CS Owner",
    "Invoice Status","Amount Due","Currency",
    "Due Date","Days Overdue","Aging Bucket","Description","Invoice URL",
  ];
  const invoiceRows = invoices.map(inv => [
    inv.account, inv.invoice_number, inv.customer_name, inv.customer_email, inv.customer_id,
    inv.domain, inv.customer_status, inv.business, inv.cs_email,
    inv.status, inv.amount_due, inv.currency,
    inv.due_date ?? "", inv.days_overdue, inv.aging_bucket, inv.description, inv.invoice_url ?? "",
  ]);

  const dsoHeaders = [
    "Account","Customer Name","Customer Email","Stripe Customer ID",
    "Domain","Status","Business","CS Owner",
    "Currency","Total Outstanding","DSO (Days)","Invoice Count",
  ];
  const dsoRows = dso.map(d => [
    d.account, d.customer_name, d.customer_email, d.customer_id,
    d.domain, d.customer_status, d.business, d.cs_email,
    d.currency, d.total_outstanding, d.dso_days, d.invoice_count,
  ]);

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: {
      valueInputOption: "USER_ENTERED",
      data: [
        { range: "Invoices!A1", values: [[`Last updated: ${timestamp}`, ...Array(invoiceHeaders.length - 1).fill("")], invoiceHeaders, ...invoiceRows] },
        { range: "DSO!A1",      values: [[`Last updated: ${timestamp}`, ...Array(dsoHeaders.length - 1).fill("")],      dsoHeaders,     ...dsoRows] },
      ],
    },
  });

  return { url: `https://docs.google.com/spreadsheets/d/${sheetId}` };
}
