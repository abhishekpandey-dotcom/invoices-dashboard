import { NextResponse } from "next/server";
import { getAllInvoices } from "@/lib/stripe";
import { readBusinessTypes } from "@/lib/sheets";

// Cache for 5 minutes on Vercel ISR
export const revalidate = 300;

export async function GET() {
  try {
    // Load business type mapping first (non-fatal if tab missing)
    const bizTypeMap = await readBusinessTypes().catch((err) => {
      console.warn("[/api/invoices] Business type mapping unavailable:", err.message);
      return new Map<string, string>();
    });

    const { invoices, dso } = await getAllInvoices(bizTypeMap);
    return NextResponse.json({ invoices, dso });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[/api/invoices]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
