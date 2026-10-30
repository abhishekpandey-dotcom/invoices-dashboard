export const dynamic = "force-dynamic";

import Stripe from "stripe";
import { NextResponse } from "next/server";

const IN_KEY = process.env.STRIPE_IN_SECRET_KEY!;
const US_KEY = process.env.STRIPE_US_SECRET_KEY!;

export interface InvoiceDumpRow {
  srNo: number;
  entity: string;
  number: string;
  billedMonth: string;
  monthAttributed: string;
  revenueType: string;
  seoNonSeo: string;
  amountDue: number;
  currency: string;
  stripeCustomerId: string;
  invoiceStatus: string;
  invoiceId: string;
  customerName: string;
  customerEmail: string;
  billedDate: string;
}

function monthLabel(ts: number): string {
  const d = new Date(ts * 1000);
  return d.toLocaleDateString("en-US", { month: "short", year: "2-digit" }).replace(" ", "-");
}

async function fetchInvoiceDump(key: string, entity: string): Promise<InvoiceDumpRow[]> {
  const stripe = new Stripe(key, { apiVersion: "2024-04-10" });
  const rows: InvoiceDumpRow[] = [];
  let hasMore = true;
  let startingAfter: string | undefined;

  while (hasMore) {
    const page = await stripe.invoices.list({
      limit: 100,
      expand: ["data.customer"],
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    for (const inv of page.data) {
      if (inv.status === "void" || inv.status === "draft") continue;
      const cObj = typeof inv.customer === "object" ? (inv.customer as Stripe.Customer) : null;
      const customerName  = cObj?.name  ?? inv.customer_name  ?? "Unknown";
      const customerEmail = cObj?.email ?? inv.customer_email ?? "";
      const customerId    = cObj?.id    ?? (typeof inv.customer === "string" ? inv.customer : "");
      const entityName    = entity === "India" ? "Delfin" : "Regents";
      const createdDate  = new Date(inv.created * 1000);
      const billedMonth  = `${createdDate.getFullYear()}-${String(createdDate.getMonth() + 1).padStart(2, "0")}`;
      const monthAttr    = monthLabel(inv.period_end || inv.created);
      rows.push({ srNo: 0, entity: entityName, number: inv.number || inv.id, billedMonth, monthAttributed: monthAttr, revenueType: "", seoNonSeo: "", amountDue: inv.amount_due / 100, currency: inv.currency.toUpperCase(), stripeCustomerId: customerId, invoiceStatus: inv.status || "unknown", invoiceId: inv.id, customerName, customerEmail, billedDate: createdDate.toISOString().split("T")[0] });
    }
    hasMore = page.has_more;
    if (!page.data.length) { hasMore = false; break; }
    startingAfter = page.data[page.data.length - 1].id;
  }
  return rows;
}

export async function GET() {
  try {
    const [india, us] = await Promise.all([fetchInvoiceDump(IN_KEY, "India"), fetchInvoiceDump(US_KEY, "US")]);
    const all = [...india, ...us].sort((a, b) => b.billedDate.localeCompare(a.billedDate)).map((r, i) => ({ ...r, srNo: i + 1 }));
    return NextResponse.json({ data: all, generatedAt: new Date().toISOString() }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) { return NextResponse.json({ error: String(e) }, { status: 500 }); }
}
