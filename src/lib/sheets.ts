import { google } from "googleapis";
import type { InvoiceRow, CustomerDSO } from "./stripe";

// ─── Auth ─────────────────────────────────────────────────────────────────────
function getAuth() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const rawKey = process.env.GOOGLE_PRIVATE_KEY;
  if (!email || !rawKey) {
    throw new Error(
      "Missing GOOGLE_SERVICE_ACCOUNT_EMAIL or GOOGLE_PRIVATE_KEY env vars."
    );
  }
  // Vercel stores \n literally — convert to real newlines
  const privateKey = rawKey.replace(/\\n/g, "\n");

  return new google.auth.JWT(email, undefined, privateKey, [
    "https://www.googleapis.com/auth/spreadsheets",
  ]);
}

// ─── Business-type mapping ────────────────────────────────────────────────────
// Reads a tab from Google Sheets and returns a Map of customer_id → business_type.
//
// The tab must have a header row. Column names are matched case-insensitively:
//   • Customer ID column  : "customer id", "customer_id", "cus id", "stripe id"
//   • Business Type column: "business type", "business_type", "type", "segment"
//
// Env vars (optional):
//   GOOGLE_BIZ_SHEET_ID  — Sheet ID if the mapping lives in a DIFFERENT spreadsheet.
//                          Falls back to GOOGLE_SHEET_ID if not set.
//   GOOGLE_BIZ_TAB_NAME  — Tab name. Defaults to "Business Types".

export type BusinessTypeMap = Map<string, string>; // customer_id → business_type

export async function readBusinessTypes(): Promise<BusinessTypeMap> {
  const sheetId =
    process.env.GOOGLE_BIZ_SHEET_ID ?? process.env.GOOGLE_SHEET_ID;
  if (!sheetId) throw new Error("Missing GOOGLE_SHEET_ID env var.");

  const tabName = process.env.GOOGLE_BIZ_TAB_NAME ?? "Business Types";

  const auth = getAuth();
  const sheets = google.sheets({ version: "v4", auth });

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${tabName}`,
  });

  const rows = res.data.values ?? [];
  if (rows.length < 2) return new Map(); // no data rows

  // Find columns by header name (case-insensitive, flexible)
  const headers = rows[0].map((h: string) => String(h).toLowerCase().trim());

  const idAliases = ["customer id", "customer_id", "cus id", "stripe id", "customerid", "id"];
  const typeAliases = ["business type", "business_type", "type", "segment", "biztype", "biz type", "businesstype"];

  const idCol = headers.findIndex((h: string) => idAliases.includes(h));
  const typeCol = headers.findIndex((h: string) => typeAliases.includes(h));

  if (idCol === -1 || typeCol === -1) {
    console.warn(
      `[readBusinessTypes] Could not find required columns in tab "${tabName}". ` +
        `Headers found: ${headers.join(", ")}. ` +
        `Expected a customer-id column and a business-type column.`
    );
    return new Map();
  }

  const map: BusinessTypeMap = new Map();
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const custId = String(row[idCol] ?? "").trim();
    const bizType = String(row[typeCol] ?? "").trim();
    if (custId && bizType) {
      map.set(custId, bizType);
    }
  }

  return map;
}

// ─── Export to Sheets ─────────────────────────────────────────────────────────
export async function exportToSheets(
  invoices: InvoiceRow[],
  dso: CustomerDSO[]
): Promise<{ url: string }> {
  const sheetId = process.env.GOOGLE_SHEET_ID;
  if (!sheetId) throw new Error("Missing GOOGLE_SHEET_ID env var.");

  const auth = getAuth();
  const sheets = google.sheets({ version: "v4", auth });

  // ── Invoices sheet ──────────────────────────────────────────────
  const invoiceHeaders = [
    "Account",
    "Invoice #",
    "Customer Name",
    "Customer Email",
    "Customer ID",
    "Business Type",
    "Status",
    "Amount Due",
    "Currency",
    "Due Date",
    "Days Overdue",
    "Aging Bucket",
    "Description",
    "Invoice URL",
  ];

  const invoiceRows = invoices.map((inv) => [
    inv.account,
    inv.invoice_number,
    inv.customer_name,
    inv.customer_email,
    inv.customer_id,
    inv.business_type ?? "",
    inv.status,
    inv.amount_due,
    inv.currency,
    inv.due_date ?? "",
    inv.days_overdue,
    inv.aging_bucket,
    inv.description,
    inv.invoice_url ?? "",
  ]);

  // ── DSO sheet ───────────────────────────────────────────────────
  const dsoHeaders = [
    "Account",
    "Customer Name",
    "Customer Email",
    "Customer ID",
    "Business Type",
    "Currency",
    "Total Outstanding",
    "DSO (Days)",
    "Invoice Count",
  ];

  const dsoRows = dso.map((d) => [
    d.account,
    d.customer_name,
    d.customer_email,
    d.customer_id,
    d.business_type ?? "",
    d.currency,
    d.total_outstanding,
    d.dso_days,
    d.invoice_count,
  ]);

  const timestamp = new Date().toISOString().replace("T", " ").slice(0, 19);

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: {
      valueInputOption: "USER_ENTERED",
      data: [
        {
          range: "Invoices!A1",
          values: [
            [`Last updated: ${timestamp}`, ...Array(invoiceHeaders.length - 1).fill("")],
            invoiceHeaders,
            ...invoiceRows,
          ],
        },
        {
          range: "DSO!A1",
          values: [
            [`Last updated: ${timestamp}`, ...Array(dsoHeaders.length - 1).fill("")],
            dsoHeaders,
            ...dsoRows,
          ],
        },
      ],
    },
  });

  return {
    url: `https://docs.google.com/spreadsheets/d/${sheetId}`,
  };
}
