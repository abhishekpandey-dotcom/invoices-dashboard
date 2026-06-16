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
  currency: string;
  due_date: string | null;
  days_overdue: number;
  aging_bucket: AgingBucket;
  invoice_url: string | null;
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
  /** DSO = outstanding / (sales_3m / 90) or fallback to (sales_12m / 365) */
  dso_days: number;
  invoice_count: number;
  /** Sum of paid invoices in the last 12 months (native currency) */
  total_sales_12m: number;
  /** Sum of paid invoices in the last 3 months / 90 days (native currency) */
  sales_3m: number;
  collection_method: "charge_automatically" | "send_invoice";
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
      const dueDateMs = inv.due_date ? inv.due_date * 1000 : null;
      const daysOverdue =
        dueDateMs && dueDateMs < now
          ? Math.floor((now - dueDateMs) / 86_400_000)
          : 0;
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
        currency: inv.currency.toUpperCase(),
        due_date: dueDateMs
          ? new Date(dueDateMs).toISOString().split("T")[0]
          : null,
        days_overdue: daysOverdue,
        aging_bucket: bucket(daysOverdue),
        invoice_url: inv.hosted_invoice_url ?? null,
        description: inv.description ?? "",
        collection_method: (inv.collection_method ?? "send_invoice") as
          | "charge_automatically"
          | "send_invoice",
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
  /** Unix seconds of the EARLIEST paid invoice found in the 12-month window */
  first_paid_sec: number;
}

async function fetchPaidSales(
  stripe: Stripe,
  account: "India" | "US"
): Promise<Map<string, PaidSummary>> {
  const map = new Map<string, PaidSummary>();
  const nowSec = Math.floor(Date.now() / 1000);
  const since12m = nowSec - 365 * 24 * 3600;
  const since3m  = nowSec - 90 * 24 * 3600;
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

      if (!map.has(key)) {
        map.set(key, { total_12m: 0, total_3m: 0, currency, collection_method: cm, first_paid_sec: inv.created });
      }
      const s = map.get(key)!;
      s.total_12m += amount;
      if (inv.created >= since3m) s.total_3m += amount;
      s.collection_method = cm; // keep most-recent invoice's value
      if (inv.created < s.first_paid_sec) s.first_paid_sec = inv.created; // track earliest in window
    }

    hasMore = page.has_more;
    startingAfter =
      page.data.length > 0 ? page.data[page.data.length - 1].id : undefined;
    if (!page.data.length) hasMore = false;
  }
  return map;
}

// ── Main export ───────────────────────────────────────────────────────────────
export async function getAllInvoices(
  metaMap: CustomerMetaMap = new Map()
): Promise<{ invoices: InvoiceRow[]; dso: CustomerDSO[] }> {
  const { india, us } = getStripeClients();

  // Parallel fetch: open invoices + paid sales history for both accounts
  const [indiaRows, usRows, indiaSales, usSales] = await Promise.all([
    fetchOpenInvoices(india, "India"),
    fetchOpenInvoices(us, "US"),
    fetchPaidSales(india, "India"),
    fetchPaidSales(us, "US"),
  ]);

  const salesMap = new Map([...indiaSales, ...usSales]);

  // Merge metadata from Google Sheets
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

  // ── Aggregate per customer ────────────────────────────────────────────────
  interface CustAgg {
    customer_id: string; customer_name: string; customer_email: string;
    domain: string; business: string; cs_email: string; customer_status: string;
    account: "India" | "US"; currency: string;
    totalOutstanding: number; count: number;
    total_sales_12m: number; sales_3m: number;
    collection_method: "charge_automatically" | "send_invoice";
    /** Earliest paid invoice timestamp in the 12-month window — used to measure actual customer tenure */
    first_paid_sec: number;
  }

  const custMap = new Map<string, CustAgg>();

  for (const inv of invoices) {
    // Key includes currency so multi-currency customers aggregate separately
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
        first_paid_sec:   paid?.first_paid_sec ?? 0,
      });
    }
    const c = custMap.get(key)!;
    c.totalOutstanding += inv.amount_due;
    c.count++;
  }

  // ── Compute DSO using tenure-aware formula ───────────────────────────────
  //   DSO = (Outstanding / Avg Monthly Revenue) × 30
  //
  //   Avg Monthly Revenue = total_sales_12m / months_active
  //   where months_active = months between the customer's EARLIEST paid invoice
  //   in the 12-month window and now.  This avoids inflating DSO for recently
  //   onboarded customers (e.g. CloudTech, 2 months old → divide by 2, not 12).
  //
  //   No cap is applied — genuinely delinquent customers will show high DSO,
  //   which is correct.  Customers with no Stripe payment history show 0 ("--").
  const nowSec = Math.floor(Date.now() / 1000);
  const dso: CustomerDSO[] = Array.from(custMap.values()).map(c => {
    let dso_days = 0;
    if (c.total_sales_12m > 0 && c.first_paid_sec > 0) {
      // How many months has this customer been paying (within our 12m window)?
      const monthsActive = Math.max(1, (nowSec - c.first_paid_sec) / (30.5 * 24 * 3600));
      const avgMonthly   = c.total_sales_12m / monthsActive;
      dso_days = avgMonthly > 0 ? Math.round((c.totalOutstanding / avgMonthly) * 30) : 0;
    }

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
