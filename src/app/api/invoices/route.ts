import { NextResponse } from "next/server";
import { getAllInvoices } from "@/lib/stripe";
import { readCustomerMetadata } from "@/lib/sheets";

export const dynamic = "force-dynamic";

const INR_PER_USD = 95;
const EUR_PER_USD = 1.17;

function toUsd(amount: number, currency: string): number {
  if (currency === "USD") return amount;
  if (currency === "EUR") return Math.round(amount * EUR_PER_USD * 100) / 100;
  // Default: treat as INR
  return Math.round((amount / INR_PER_USD) * 100) / 100;
}

export async function GET() {
  try {
    const metaMap = await readCustomerMetadata().catch((err) => {
      console.warn("[/api/invoices] Metadata unavailable:", err.message);
      return new Map();
    });

    const { invoices, dso } = await getAllInvoices(metaMap);

    // Add USD-converted amount to each invoice row
    const invoicesWithUsd = invoices.map(inv => ({
      ...inv,
      amount_usd: toUsd(inv.amount_due, inv.currency),
    }));

    // DSO is already correctly calculated in lib/stripe.ts using native-currency
    // ratios (outstanding / daily_sales_rate). The ratio is currency-independent,
    // so dso_days does NOT need to be recalculated here.
    // We only convert monetary totals to USD for display.
    const dsoWithUsd = dso.map(d => ({
      ...d,
      total_outstanding_usd: toUsd(d.total_outstanding, d.currency),
      total_sales_12m_usd:   toUsd(d.total_sales_12m,  d.currency),
      sales_3m_usd:          toUsd(d.sales_3m,          d.currency),
    }));

    return NextResponse.json({
      invoices: invoicesWithUsd,
      dso:      dsoWithUsd,
      inrPerUsd: INR_PER_USD,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[/api/invoices]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
