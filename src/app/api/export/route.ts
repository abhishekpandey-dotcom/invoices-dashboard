import { NextResponse } from "next/server";
import { getAllInvoices } from "@/lib/stripe";
import { exportToSheets } from "@/lib/sheets";

export async function POST() {
  try {
    const { invoices, dso } = await getAllInvoices();
    const result = await exportToSheets(invoices, dso);
    return NextResponse.json(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[/api/export]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
