import { NextResponse } from "next/server";
import { exportToSheets } from "@/lib/sheets";

export async function POST(request: Request) {
  try {
    // Use the same data pipeline as the dashboard
    const host     = request.headers.get("host") ?? "localhost:3000";
    const protocol = host.includes("localhost") ? "http" : "https";
    const res      = await fetch(`${protocol}://${host}/api/invoices`, { cache: "no-store" });
    const json     = await res.json();

    if (json.error) throw new Error(json.error);

    const result = await exportToSheets(json.invoices, json.dso);
    return NextResponse.json(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[export]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
