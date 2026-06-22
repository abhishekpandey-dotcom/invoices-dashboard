import { NextResponse } from "next/server";
import { getAllCustomers, AllCustomer } from "@/lib/stripe";
import { readCustomerMetadata } from "@/lib/sheets";

export const dynamic = "force-dynamic";

// ── Simple in-memory cache (survives across requests in the same server process) ─
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

let _cache: {
  customers: AllCustomer[];
  fetchedAt: number;
} | null = null;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const bust = searchParams.get("bust") === "1";

  // Return cached data if fresh and not explicitly busted
  if (!bust && _cache && Date.now() - _cache.fetchedAt < CACHE_TTL_MS) {
    return NextResponse.json({
      customers: _cache.customers,
      cached: true,
      age_seconds: Math.round((Date.now() - _cache.fetchedAt) / 1000),
    });
  }

  try {
    const metaMap = await readCustomerMetadata().catch((err) => {
      console.warn("[/api/all-customers] Metadata unavailable:", err.message);
      return new Map();
    });

    const customers = await getAllCustomers(metaMap);

    // Store in cache
    _cache = { customers, fetchedAt: Date.now() };

    return NextResponse.json({ customers, cached: false });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[/api/all-customers]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
