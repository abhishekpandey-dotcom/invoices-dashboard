import { NextResponse } from "next/server";
import { google } from "googleapis";

export async function GET() {
  const log: Record<string, unknown> = {};

  const jsonEnv = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  log.env_var_present = !!jsonEnv;
  log.env_var_length = jsonEnv?.length ?? 0;

  if (!jsonEnv) {
    return NextResponse.json({ error: "GOOGLE_SERVICE_ACCOUNT_JSON is not set", log });
  }

  let creds: Record<string, string>;
  try {
    creds = JSON.parse(jsonEnv);
    log.json_parse = "OK";
    log.client_email = creds.client_email ?? "MISSING";
    log.private_key_present = !!creds.private_key;
    log.private_key_starts = creds.private_key?.slice(0, 40) ?? "MISSING";
  } catch (e) {
    log.json_parse = "FAILED";
    log.json_parse_error = String(e);
    return NextResponse.json({ error: "JSON.parse failed", log });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let auth: any;
  try {
    auth = new google.auth.JWT(
      creds.client_email,
      undefined,
      creds.private_key,
      ["https://www.googleapis.com/auth/spreadsheets"]
    );
    log.auth_build = "OK";
  } catch (e) {
    log.auth_build = "FAILED";
    log.auth_error = String(e);
    return NextResponse.json({ error: "Auth build failed", log });
  }

  const sheetId = process.env.GOOGLE_SHEET_ID;
  const tabName = process.env.GOOGLE_BIZ_TAB_NAME ?? "Customer Domain Name";
  log.sheet_id = sheetId ?? "NOT SET";
  log.tab_name = tabName;

  if (!sheetId) {
    return NextResponse.json({ error: "GOOGLE_SHEET_ID not set", log });
  }

  try {
    const sheets = google.sheets({ version: "v4", auth });
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: tabName,
    });
    const rows = res.data.values ?? [];
    log.sheet_read = "OK";
    log.total_rows = rows.length;
    log.headers = rows[0] ?? [];
    log.first_data_row = rows[1] ?? [];
  } catch (e: unknown) {
    log.sheet_read = "FAILED";
    log.sheet_error = e instanceof Error ? e.message : String(e);
  }

  return NextResponse.json({ log });
}
