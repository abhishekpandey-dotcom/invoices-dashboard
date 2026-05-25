import { NextResponse } from "next/server";
import { getAllInvoices } from "@/lib/stripe";
import { readCustomerMetadata } from "@/lib/sheets";

export const revalidate = 300;

export async function GET() {
  try {
    const metaMap = await readCustomerMetadata().catch((err) => {
      console.warn("[/api/invoices] Customer metadata unavailable:", err.message);
      return new Map();
    });
    const { invoices, dso } = await getAllInvoices(metaMap);
    return NextResponse.json({ invoices, dso });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[/api/invoices]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
