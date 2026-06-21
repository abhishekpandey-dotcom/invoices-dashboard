import { NextResponse } from "next/server";
import { getAllCustomers } from "@/lib/stripe";
import { readCustomerMetadata } from "@/lib/sheets";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const metaMap = await readCustomerMetadata().catch((err) => {
      console.warn("[/api/all-customers] Metadata unavailable:", err.message);
      return new Map();
    });

    const customers = await getAllCustomers(metaMap);
    return NextResponse.json({ customers });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[/api/all-customers]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
