import { NextResponse } from "next/server";
import { getAllInvoices } from "@/lib/stripe";
import { readCustomerMetadata, exportToSheets } from "@/lib/sheets";

export async function POST() {
  try {
    const metaMap = await readCustomerMetadata().catch(() => new Map<string, import("@/lib/sheets").CustomerMeta>());
    const { invoices, dso } = await getAllInvoices(metaMap);
    const result = await exportToSheets(invoices, dso);
    return NextResponse.json(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[/api/export]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
