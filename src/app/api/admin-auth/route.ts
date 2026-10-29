import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  const { password } = await req.json();
  const adminPassword = process.env.ADMIN_PASSWORD ?? "gush@admin2024";
  return NextResponse.json({ ok: password === adminPassword });
}
