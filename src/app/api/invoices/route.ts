import { NextResponse } from "next/server";
import { getAllInvoices } from "@/lib/stripe";
import { readCustomerMetadata } from "@/lib/sheets";

export const dynamic = "force-dynamic"; // always fetch fresh data — no Vercel cache

const INR_PER_USD = 95;
const EUR_PER_USD = 1.17;

function toUsd(amount: number, currency: string): number {
  if (currency === "USD") return amount;
  if (currency === "EUR") return Math.round(amount * EUR_PER_USD * 100) / 100;
  return Math.round((amount / INR_PER_USD) * 100) / 100;
}

export async function GET() {
  try {
    const metaMap = await readCustomerMetadata().catch((err) => {
      console.warn("[/api/invoices] Metadata unavailable:", err.message);
      return new Map();
    });
    const { invoices, dso } = await getAllInvoices(metaMap);
    const invoicesWithUsd = invoices.map(inv => ({
      ...inv,
      amount_usd: toUsd(inv.amount_due, inv.currency),
    }));
    const dsoWithUsd = dso.map(d => {
      const total_outstanding_usd = toUsd(d.total_outstanding, d.currency);
      const avg_invoice_usd = d.invoice_count > 0
        ? total_outstanding_usd / d.invoice_count
        : 0;
      const dso_days = avg_invoice_usd > 0
        ? Math.round(total_outstanding_usd / (avg_invoice_usd / 30))
        : 0;
      return { ...d, total_outstanding_usd, dso_days };
    });
    return NextResponse.json({
      invoices: invoicesWithUsd,
      dso: dsoWithUsd,
      inrPerUsd: INR_PER_USD,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[/api/invoices]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
