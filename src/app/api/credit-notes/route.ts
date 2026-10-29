import Stripe from "stripe";
import { NextResponse } from "next/server";

const IN_KEY = process.env.STRIPE_IN_SECRET_KEY!;
const US_KEY = process.env.STRIPE_US_SECRET_KEY!;

export interface CnDumpRow {
  srNo: number;
  creditNoteNumber: string;
  stripeCustomerId: string;
  type: string;             // post_payment / pre_payment
  amount: number;
  cnStatus: string;         // issued / void
  currency: string;
  invoiceId: string;
  createdDate: string;      // ISO
  effectiveDate: string;    // ISO
  effectiveMonth: string;   // YYYY-MM  (client-side filter)
  effectiveMonthLabel: string; // "Sep-26"
  invoiceNumber: string;
  entity: string;
  customerEmail: string;
  revenueType: string;      // YES / NO
  seoNonSeo: string;
  invoiceAmount: number;
  attributedMonth: string;  // billing period month from parent invoice
  customerName: string;
  memo: string;
}

function monthLabel(ts: number): string {
  const d = new Date(ts * 1000);
  return d.toLocaleDateString("en-US", { month: "short", year: "2-digit" }).replace(" ", "-");
}
function isoMonth(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

async function fetchCreditNotes(key: string, entity: string): Promise<CnDumpRow[]> {
  const stripe = new Stripe(key, { apiVersion: "2024-04-10" });
  const rows: CnDumpRow[] = [];
  let hasMore = true;
  let startingAfter: string | undefined;

  while (hasMore) {
    const page = await stripe.creditNotes.list({
      limit: 100,
      expand: ["data.customer", "data.invoice"],
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });

    for (const cn of page.data) {
      const cObj = typeof cn.customer === "object" ? (cn.customer as Stripe.Customer) : null;
      const inv  = typeof cn.invoice  === "object" ? (cn.invoice  as Stripe.Invoice)  : null;

      const customerName  = cObj?.name  ?? "Unknown";
      const customerEmail = cObj?.email ?? "";
      const customerId    = cObj?.id    ?? (typeof cn.customer === "string" ? cn.customer : "");
      const entityName    = (cObj?.metadata?.entity as string) || entity;
      const isSubscription = !!(inv?.subscription);

      let seoLabel = "Non SEO";
      if (inv?.lines?.data) {
        for (const l of inv.lines.data) {
          if ((l.description ?? "").toLowerCase().includes("seo")) { seoLabel = "SEO"; break; }
        }
      }

      const createdDate   = new Date(cn.created * 1000);
      const effectiveDate = cn.effective_at ? new Date(cn.effective_at * 1000) : createdDate;
      const effMonth      = isoMonth(effectiveDate);
      const effLabel      = monthLabel(cn.effective_at || cn.created);
      const attrMonth     = inv?.period_end ? monthLabel(inv.period_end) : effLabel;

      rows.push({
        srNo: 0,
        creditNoteNumber: cn.number || cn.id,
        stripeCustomerId: customerId,
        type: cn.type,
        amount: cn.amount / 100,
        cnStatus: cn.status,
        currency: cn.currency.toUpperCase(),
        invoiceId: inv?.id ?? (typeof cn.invoice === "string" ? cn.invoice : ""),
        createdDate: createdDate.toISOString().split("T")[0],
        effectiveDate: effectiveDate.toISOString().split("T")[0],
        effectiveMonth: effMonth,
        effectiveMonthLabel: effLabel,
        invoiceNumber: inv?.number ?? "",
        entity: entityName,
        customerEmail,
        revenueType: isSubscription ? "YES" : "NO",
        seoNonSeo: seoLabel,
        invoiceAmount: inv ? inv.amount_due / 100 : 0,
        attributedMonth: attrMonth,
        customerName,
        memo: cn.memo ?? "",
      });
    }

    hasMore = page.has_more;
    if (!page.data.length) { hasMore = false; break; }
    startingAfter = page.data[page.data.length - 1].id;
  }

  return rows;
}

export async function GET() {
  try {
    const [india, us] = await Promise.all([
      fetchCreditNotes(IN_KEY, "India"),
      fetchCreditNotes(US_KEY, "US"),
    ]);
    const all = [...india, ...us]
      .sort((a, b) => b.createdDate.localeCompare(a.createdDate))
      .map((r, i) => ({ ...r, srNo: i + 1 }));
    return NextResponse.json({ data: all, generatedAt: new Date().toISOString() }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
