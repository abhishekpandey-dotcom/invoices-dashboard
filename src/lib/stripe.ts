import Stripe from "stripe";
import type { CustomerMetaMap } from "./sheets";

export function getStripeClients() {
  const inKey = process.env.STRIPE_IN_SECRET_KEY;
  const usKey = process.env.STRIPE_US_SECRET_KEY;
  if (!inKey || !usKey)
    throw new Error(
      "Missing Stripe keys. Set STRIPE_IN_SECRET_KEY and STRIPE_US_SECRET_KEY."
    );
  return {
    india: new Stripe(inKey, { apiVersion: "2024-04-10" }),
    us:    new Stripe(usKey, { apiVersion: "2024-04-10" }),
  };
}

// ── Types ─────────────────────────────────────────────────────────────────────
export type AgingBucket = "0-30" | "31-60" | "61-90" | "90-180" | "180+";

export interface InvoiceRow {
  id: string;
  account: "India" | "US";
  customer_id: string;
  customer_name: string;
  customer_email: string;
  domain: string;
  business: string;
  cs_email: string;
  customer_status: string;
  invoice_number: string;
  status: string;
  amount_due: number;
  /** Tax amount on this invoice (0 if none) */
  tax: number;
  /** Pre-tax subtotal — used as ex-tax base for DSO.
   *  Uses subtotal_excluding_tax (handles inclusive GST), falls back to subtotal, then amount_due */
  subtotal: number;
  currency: string;
  /** ISO date of invoice creation (always set) */
  invoice_date: string;
  /**
   * Effective due date.
   * For autopay customers with no explicit due_date, falls back to invoice_date.
   * For manual customers with no due_date, remains null.
   */
  due_date: string | null;
  /** Days overdue measured from effective due_date */
  days_overdue: number;
  /** Aging bucket from effective due_date */
  aging_bucket: AgingBucket;
  /** Days since invoice was created (always >= 0) */
  days_from_invoice: number;
  /** Aging bucket measured from invoice creation date */
  aging_bucket_from_invoice: AgingBucket;
  invoice_url: string | null;
  invoice_pdf: string | null;
  description: string;
  collection_method: "charge_automatically" | "send_invoice";
}

export interface CustomerDSO {
  customer_id: string;
  customer_name: string;
  customer_email: string;
  domain: string;
  business: string;
  cs_email: string;
  customer_status: string;
  account: "India" | "US";
  total_outstanding: number;
  currency: string;
  /** DSO = Total Outstanding (ex-tax) / Daily MRR, where Daily MRR = Last Invoice (ex-tax) / 30 */
  dso_days: number;
  /** Sum of (amount_due - tax) across open invoices — for aggregate DSO numerator */
  total_outstanding_ex_tax: number;
  /** Ex-tax amount of most recent open invoice — for aggregate DSO denominator base */
  latest_invoice_amt_ex_tax: number;
  invoice_count: number;
  /** Sum of paid invoices in the last 12 months (native currency) */
  total_sales_12m: number;
  /** Sum of paid invoices in the last 3 months / 90 days (native currency) */
  sales_3m: number;
  collection_method: "charge_automatically" | "send_invoice";
}

// ── AllCustomer types (for the full ledger tab) ────────────────────────────────
export interface AllCustomerInvoice {
  id: string;
  invoice_number: string;
  /** "paid" | "open" | "void" | "uncollectible" */
  status: string;
  /** Total amount in native currency */
  amount: number;
  /** Amount already paid (native currency) */
  amount_paid: number;
  currency: string;
  /** ISO date of invoice creation */
  invoice_date: string;
  /** ISO date of due date (null if none) */
  due_date: string | null;
  /** Start of service period from first line item */
  period_start: string | null;
  /** End of service period from first line item */
  period_end: string | null;
  invoice_url: string | null;
  invoice_pdf: string | null;
  /** Stripe receipt URL (available on paid invoices) */
  receipt_url: string | null;
  description: string;
  collection_method: "charge_automatically" | "send_invoice";
}

export interface AllCustomer {
  customer_id: string;
  customer_name: string;
  customer_email: string;
  domain: string;
  business: string;
  cs_email: string;
  customer_status: string;
  account: "India" | "US";
  collection_method: "charge_automatically" | "send_invoice";
  /** Oldest invoice date found in the 18-month window */
  first_invoice_date: string | null;
  /** Most recent invoice date */
  latest_invoice_date: string | null;
  currency: string;
  /** All invoices in the 18-month window, sorted newest first */
  invoices: AllCustomerInvoice[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const SKIP = new Set(["paid", "void", "draft", "uncollectible"]);

function bucket(d: number): AgingBucket {
  if (d <= 30)  return "0-30";
  if (d <= 60)  return "31-60";
  if (d <= 90)  return "61-90";
  if (d <= 180) return "90-180";
  return "180+";
}

// ── Fetch open invoices ───────────────────────────────────────────────────────
type RawRow = Omit<InvoiceRow, "domain" | "business" | "cs_email" | "customer_status">;

async function fetchOpenInvoices(
  stripe: Stripe,
  account: "India" | "US"
): Promise<RawRow[]> {
  const rows: RawRow[] = [];
  const now = Date.now();
  let hasMore = true;
  let startingAfter: string | undefined;

  while (hasMore) {
    const page = await stripe.invoices.list({
      status: "open",
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });

    for (const inv of page.data) {
      if (SKIP.has(inv.status ?? "")) continue;

      const invoiceDateMs = inv.created * 1000;
      const cm = (inv.collection_method ?? "send_invoice") as
        | "charge_automatically"
        | "send_invoice";

      // For autopay customers with no due_date, use invoice creation date as the
      // effective due date so they are correctly aged instead of landing in 0-30.
      const effectiveDueDateMs = inv.due_date
        ? inv.due_date * 1000
        : cm === "charge_automatically"
          ? invoiceDateMs
          : null;

      const daysOverdue =
        effectiveDueDateMs && effectiveDueDateMs < now
          ? Math.floor((now - effectiveDueDateMs) / 86_400_000)
          : 0;

      // Always compute aging from invoice date regardless of collection method
      const daysFromInvoice = Math.max(
        0,
        Math.floor((now - invoiceDateMs) / 86_400_000)
      );

      const cObj =
        typeof inv.customer === "object" && inv.customer !== null
          ? (inv.customer as Stripe.Customer)
          : null;
      const cId =
        typeof inv.customer === "string"
          ? inv.customer
          : (cObj?.id ?? "");

      rows.push({
        id: inv.id,
        account,
        customer_id: cId,
        customer_name: cObj?.name ?? inv.customer_name ?? inv.customer_email ?? "Unknown",
        customer_email: cObj?.email ?? inv.customer_email ?? "",
        invoice_number: inv.number ?? inv.id,
        status: inv.status ?? "open",
        amount_due: inv.amount_due / 100,
        tax: (inv.tax ?? 0) / 100,
        // subtotal_excluding_tax handles inclusive GST (common in India);
        // subtotal handles exclusive GST; amount_due is the last resort
        subtotal: (inv.subtotal_excluding_tax ?? inv.subtotal ?? inv.amount_due) / 100,
        currency: inv.currency.toUpperCase(),
        invoice_date: new Date(invoiceDateMs).toISOString().split("T")[0],
        due_date: effectiveDueDateMs
          ? new Date(effectiveDueDateMs).toISOString().split("T")[0]
          : null,
        days_overdue: daysOverdue,
        aging_bucket: bucket(daysOverdue),
        days_from_invoice: daysFromInvoice,
        aging_bucket_from_invoice: bucket(daysFromInvoice),
        invoice_url: inv.hosted_invoice_url ?? null,
        invoice_pdf: inv.invoice_pdf        ?? null,
        description: inv.description ?? "",
        collection_method: cm,
      });
    }

    hasMore = page.has_more;
    startingAfter =
      page.data.length > 0 ? page.data[page.data.length - 1].id : undefined;
    if (!page.data.length) hasMore = false;
  }
  return rows;
}

// ── Fetch paid invoice totals ─────────────────────────────────────────────────
interface PaidSummary {
  total_12m: number;
  total_3m: number;
  currency: string;
  collection_method: "charge_automatically" | "send_invoice";
  customer_name: string;
  customer_email: string;
  /** Ex-tax amount of the most recent paid invoice — MRR fallback for inactive customers */
  latestPaidAmtExTax: number;
  /** ISO date of the most recent paid invoice */
  latestPaidDate: string;
}

async function fetchPaidSales(
  stripe: Stripe,
  account: "India" | "US"
): Promise<Map<string, PaidSummary>> {
  const map = new Map<string, PaidSummary>();
  const nowSec = Math.floor(Date.now() / 1000);
  const since12m = nowSec - 365 * 24 * 3600;
  const since3m  = nowSec - 90  * 24 * 3600;
  let hasMore = true;
  let startingAfter: string | undefined;

  while (hasMore) {
    const page = await stripe.invoices.list({
      status: "paid",
      limit: 100,
      created: { gte: since12m },
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });

    for (const inv of page.data) {
      const cObj =
        typeof inv.customer === "object" && inv.customer !== null
          ? (inv.customer as Stripe.Customer)
          : null;
      const cId =
        typeof inv.customer === "string" ? inv.customer : (cObj?.id ?? "");
      const key = `${account}::${cId}`;
      const amount = (inv.amount_paid ?? inv.total ?? 0) / 100;
      const currency = inv.currency.toUpperCase();
      const cm = (inv.collection_method ?? "send_invoice") as
        | "charge_automatically"
        | "send_invoice";
      const cName  = cObj?.name  ?? inv.customer_name  ?? inv.customer_email ?? "Unknown";
      const cEmail = cObj?.email ?? inv.customer_email ?? "";

      const invDate = new Date(inv.created * 1000).toISOString().split("T")[0];
      // subtotal_excluding_tax handles inclusive GST; subtotal handles exclusive GST
      const paidAmtExTax = (inv.subtotal_excluding_tax ?? inv.subtotal ?? (inv.amount_paid ?? inv.total ?? 0)) / 100;

      if (!map.has(key)) {
        map.set(key, { total_12m: 0, total_3m: 0, currency, collection_method: cm, customer_name: cName, customer_email: cEmail, latestPaidAmtExTax: 0, latestPaidDate: "" });
      }
      const s = map.get(key)!;
      s.total_12m += amount;
      if (inv.created >= since3m) s.total_3m += amount;
      s.collection_method = cm;
      // Track most recent paid invoice as MRR fallback
      if (!s.latestPaidDate || invDate > s.latestPaidDate) {
        s.latestPaidDate       = invDate;
        s.latestPaidAmtExTax   = paidAmtExTax;
      }
    }

    hasMore = page.has_more;
    startingAfter =
      page.data.length > 0 ? page.data[page.data.length - 1].id : undefined;
    if (!page.data.length) hasMore = false;
  }
  return map;
}

// ── Fetch all invoices for the ledger tab ─────────────────────────────────────
async function fetchAllCustomerInvoices(
  stripe: Stripe,
  account: "India" | "US",
  sinceMs: number
): Promise<Map<string, { meta: Partial<AllCustomer>; invoices: AllCustomerInvoice[] }>> {
  const map = new Map<string, { meta: Partial<AllCustomer>; invoices: AllCustomerInvoice[] }>();
  const since = Math.floor(sinceMs / 1000);
  let hasMore = true;
  let startingAfter: string | undefined;

  while (hasMore) {
    const page = await stripe.invoices.list({
      limit: 100,
      created: { gte: since },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expand: ["data.charge"] as any,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });

    for (const inv of page.data) {
      // Skip drafts — they're not real invoices yet
      if (inv.status === "draft") continue;

      const cObj =
        typeof inv.customer === "object" && inv.customer !== null
          ? (inv.customer as Stripe.Customer)
          : null;
      const cId =
        typeof inv.customer === "string" ? inv.customer : (cObj?.id ?? "");
      if (!cId) continue;

      const key = `${account}::${cId}`;
      const cm = (inv.collection_method ?? "send_invoice") as
        | "charge_automatically"
        | "send_invoice";

      // Service period from first line item
      const firstLine = inv.lines?.data?.[0];
      const periodStart = firstLine?.period?.start
        ? new Date(firstLine.period.start * 1000).toISOString().split("T")[0]
        : null;
      const periodEnd = firstLine?.period?.end
        ? new Date(firstLine.period.end * 1000).toISOString().split("T")[0]
        : null;

      // Receipt URL from expanded charge (available on paid invoices)
      const charge =
        inv.charge && typeof inv.charge === "object"
          ? (inv.charge as Stripe.Charge)
          : null;
      const receiptUrl = charge?.receipt_url ?? null;

      const invoiceDate = new Date(inv.created * 1000).toISOString().split("T")[0];
      const dueDateStr = inv.due_date
        ? new Date(inv.due_date * 1000).toISOString().split("T")[0]
        : null;

      const invoiceRow: AllCustomerInvoice = {
        id: inv.id,
        invoice_number: inv.number ?? inv.id,
        status: inv.status ?? "open",
        amount: (inv.amount_due ?? inv.total ?? 0) / 100,
        amount_paid: (inv.amount_paid ?? 0) / 100,
        currency: inv.currency.toUpperCase(),
        invoice_date: invoiceDate,
        due_date: dueDateStr,
        period_start: periodStart,
        period_end: periodEnd,
        invoice_url: inv.hosted_invoice_url ?? null,
        invoice_pdf: inv.invoice_pdf ?? null,
        receipt_url: receiptUrl,
        description: inv.description ?? "",
        collection_method: cm,
      };

      if (!map.has(key)) {
        map.set(key, {
          meta: {
            customer_id: cId,
            customer_name: cObj?.name ?? inv.customer_name ?? inv.customer_email ?? "Unknown",
            customer_email: cObj?.email ?? inv.customer_email ?? "",
            account,
            currency: inv.currency.toUpperCase(),
            collection_method: cm,
          },
          invoices: [],
        });
      }
      const entry = map.get(key)!;
      entry.invoices.push(invoiceRow);
      // Keep most-recent collection_method
      entry.meta.collection_method = cm;
    }

    hasMore = page.has_more;
    startingAfter =
      page.data.length > 0 ? page.data[page.data.length - 1].id : undefined;
    if (!page.data.length) hasMore = false;
  }
  return map;
}

// ── Main export: outstanding invoices + DSO ───────────────────────────────────
export async function getAllInvoices(
  metaMap: CustomerMetaMap = new Map()
): Promise<{ invoices: InvoiceRow[]; dso: CustomerDSO[] }> {
  const { india, us } = getStripeClients();

  const [indiaRows, usRows, indiaSales, usSales] = await Promise.all([
    fetchOpenInvoices(india, "India"),
    fetchOpenInvoices(us, "US"),
    fetchPaidSales(india, "India"),
    fetchPaidSales(us, "US"),
  ]);

  const salesMap = new Map([...indiaSales, ...usSales]);

  const invoices: InvoiceRow[] = [...indiaRows, ...usRows].map(inv => {
    const meta = metaMap.get(inv.customer_id);
    return {
      ...inv,
      domain: meta?.domain ?? "",
      business: meta?.business ?? "",
      cs_email: meta?.cs_email ?? "",
      customer_status: meta?.status ?? "",
    };
  });

  interface CustAgg {
    customer_id: string; customer_name: string; customer_email: string;
    domain: string; business: string; cs_email: string; customer_status: string;
    account: "India" | "US"; currency: string;
    totalOutstanding: number; count: number;
    total_sales_12m: number; sales_3m: number;
    collection_method: "charge_automatically" | "send_invoice";
    /** Sum of subtotal across all open invoices — used for DSO numerator */
    totalOutstandingExTax: number;
    /** subtotal of the most recent open invoice — used as MRR proxy */
    latestInvoiceAmtExTax: number;
    /** Invoice date of the most recent open invoice */
    latestInvoiceDate: string;
  }

  const custMap = new Map<string, CustAgg>();

  for (const inv of invoices) {
    const key      = `${inv.account}::${inv.customer_id}::${inv.currency}`;
    const salesKey = `${inv.account}::${inv.customer_id}`;
    const paid     = salesMap.get(salesKey);

    if (!custMap.has(key)) {
      custMap.set(key, {
        customer_id:     inv.customer_id,
        customer_name:   inv.customer_name,
        customer_email:  inv.customer_email,
        domain:          inv.domain,
        business:        inv.business,
        cs_email:        inv.cs_email,
        customer_status: inv.customer_status,
        account:         inv.account,
        currency:        inv.currency,
        totalOutstanding: 0,
        count:            0,
        total_sales_12m:  paid?.total_12m     ?? 0,
        sales_3m:         paid?.total_3m      ?? 0,
        collection_method: paid?.collection_method ?? inv.collection_method,
        totalOutstandingExTax: 0,
        latestInvoiceAmtExTax: 0,
        latestInvoiceDate:     "",
      });
    }
    const c = custMap.get(key)!;
    c.totalOutstanding += inv.amount_due;
    c.count++;

    // DSO: use subtotal (Stripe's pre-tax field) — correct for both inclusive and exclusive GST
    c.totalOutstandingExTax += inv.subtotal;

    // Track the most recent invoice as MRR proxy
    if (!c.latestInvoiceDate || inv.invoice_date > c.latestInvoiceDate) {
      c.latestInvoiceDate     = inv.invoice_date;
      c.latestInvoiceAmtExTax = inv.subtotal;
    }
  }

  // Add paid-only customers (active in last 12m but no open invoices)
  for (const [salesKey, paid] of salesMap.entries()) {
    const parts   = salesKey.split("::");
    const account = parts[0] as "India" | "US";
    const custId  = parts[1];
    const key     = `${account}::${custId}::${paid.currency}`;
    if (custMap.has(key)) continue;
    const meta = metaMap.get(custId);
    custMap.set(key, {
      customer_id:      custId,
      customer_name:    paid.customer_name,
      customer_email:   paid.customer_email,
      domain:           meta?.domain   ?? "",
      business:         meta?.business ?? "",
      cs_email:         meta?.cs_email ?? "",
      customer_status:  meta?.status   ?? "",
      account,
      currency:         paid.currency,
      totalOutstanding: 0,
      count:            0,
      total_sales_12m:  paid.total_12m,
      sales_3m:         paid.total_3m,
      collection_method: paid.collection_method,
      totalOutstandingExTax: 0,
      latestInvoiceAmtExTax: 0,
      latestInvoiceDate:     "",
    });
  }

  const dso: CustomerDSO[] = Array.from(custMap.values()).map(c => {
    // DSO = Total Outstanding (ex-tax) / Daily MRR
    // Daily MRR = Last Invoice Amount (ex-tax) / 30
    // Use most recent invoice (open OR paid) as MRR proxy — critical for inactive
    // customers whose most recent invoice was their last paid subscription charge.
    const salesKey  = `${c.account}::${c.customer_id}`;
    const paidEntry = salesMap.get(salesKey);
    const useOpenAsMrr =
      !paidEntry?.latestPaidDate ||
      (c.latestInvoiceDate && c.latestInvoiceDate >= paidEntry.latestPaidDate);
    const mrrAmtExTax = useOpenAsMrr
      ? c.latestInvoiceAmtExTax
      : (paidEntry?.latestPaidAmtExTax ?? 0);

    const dailyMrr = mrrAmtExTax / 30;
    const dso_days = c.totalOutstandingExTax > 0 && dailyMrr > 0
      ? Math.round(c.totalOutstandingExTax / dailyMrr)
      : 0;
    return {
      customer_id:     c.customer_id,
      customer_name:   c.customer_name,
      customer_email:  c.customer_email,
      domain:          c.domain,
      business:        c.business,
      cs_email:        c.cs_email,
      customer_status: c.customer_status,
      account:         c.account,
      currency:        c.currency,
      total_outstanding: Math.round(c.totalOutstanding * 100) / 100,
      total_outstanding_ex_tax: Math.round(c.totalOutstandingExTax * 100) / 100,
      latest_invoice_amt_ex_tax: Math.round(mrrAmtExTax * 100) / 100,
      dso_days,
      invoice_count:    c.count,
      total_sales_12m:  Math.round(c.total_sales_12m * 100) / 100,
      sales_3m:         Math.round(c.sales_3m * 100) / 100,
      collection_method: c.collection_method,
    };
  });

  dso.sort((a, b) => b.total_outstanding - a.total_outstanding);
  return { invoices, dso };
}

// ── Main export: full customer ledger (all statuses, 18 months) ───────────────
export async function getAllCustomers(
  metaMap: CustomerMetaMap = new Map()
): Promise<AllCustomer[]> {
  const { india, us } = getStripeClients();
  const now = Date.now();
  const since18m = now - 18 * 30 * 24 * 3600 * 1000;

  const [indiaMap, usMap] = await Promise.all([
    fetchAllCustomerInvoices(india, "India", since18m),
    fetchAllCustomerInvoices(us, "US", since18m),
  ]);

  const threeMonthsAgo = new Date(now - 90 * 24 * 3600 * 1000)
    .toISOString()
    .split("T")[0];

  const result: AllCustomer[] = [];

  for (const [, { meta, invoices }] of new Map([...indiaMap, ...usMap]).entries()) {
    const custId = meta.customer_id ?? "";

    // Sort newest first
    invoices.sort((a, b) => b.invoice_date.localeCompare(a.invoice_date));

    const dates = invoices.map(i => i.invoice_date).filter(Boolean);
    const latestDate = dates[0] ?? null;
    const firstDate  = dates[dates.length - 1] ?? null;

    const sheetMeta = metaMap.get(custId);
    const status    = sheetMeta?.status ?? "";

    // Exclude churned customers who have had no invoice in the last 3 months
    if (status === "Churned" && (!latestDate || latestDate < threeMonthsAgo)) continue;

    result.push({
      customer_id:          custId,
      customer_name:        meta.customer_name ?? "",
      customer_email:       meta.customer_email ?? "",
      domain:               sheetMeta?.domain   ?? "",
      business:             sheetMeta?.business ?? "",
      cs_email:             sheetMeta?.cs_email ?? "",
      customer_status:      status,
      account:              meta.account ?? "India",
      currency:             meta.currency ?? "USD",
      collection_method:    meta.collection_method ?? "send_invoice",
      first_invoice_date:   firstDate,
      latest_invoice_date:  latestDate,
      invoices,
    });
  }

  // Sort by latest invoice date descending
  result.sort((a, b) =>
    (b.latest_invoice_date ?? "").localeCompare(a.latest_invoice_date ?? "")
  );
  return result;
}
