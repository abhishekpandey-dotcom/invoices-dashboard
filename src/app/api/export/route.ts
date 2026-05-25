import { NextResponse } from "next/server";
import { exportToSheets } from "@/lib/sheets";

export async function POST(request: Request) {
  try {
    const host  = request.headers.get("host") ?? "localhost:3000";
    const proto = host.includes("localhost") ? "http" : "https";
    const apiRes = await fetch(`${proto}://${host}/api/invoices`, { cache: "no-store" });
    if (!apiRes.ok) throw new Error(`Invoices API returned ${apiRes.status}`);
    const { invoices, dso } = await apiRes.json();
    const result = await exportToSheets(invoices, dso);
    return NextResponse.json(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[/api/export]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
