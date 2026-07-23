import { NextResponse } from "next/server";
import { getPlanSnapshots, CustomerPlanSnapshot } from "@/lib/stripe";
import {
  readCustomerMetadata,
  readPlanSnapshots,
  writePlanSnapshots,
  appendPlanChanges,
  readPlanChanges,
  PlanChangeRow,
  PlanSnapshotRow,
} from "@/lib/sheets";

export const dynamic = "force-dynamic";

// A cent-level tolerance avoids flagging floating-point noise as a real change.
const VALUE_EPSILON = 0.01;

export async function GET() {
  try {
    const metaMap = await readCustomerMetadata().catch((err) => {
      console.warn("[/api/plan-changes] Metadata unavailable:", err.message);
      return new Map();
    });

    const current = await getPlanSnapshots(metaMap);
    const previous = await readPlanSnapshots().catch((err) => {
      console.warn("[/api/plan-changes] No prior snapshot (first run?):", err.message);
      return new Map<string, PlanSnapshotRow>();
    });

    const nowIso = new Date().toISOString();
    const newChanges: PlanChangeRow[] = [];

    for (const c of current) {
      const key = `${c.account}::${c.customer_id}`;
      const prev = previous.get(key);
      if (!prev) continue; // first time we've seen this customer — just record a baseline, no change event

      const sameCurrency = prev.currency === c.currency;
      const valueChanged = Math.abs(prev.plan_value - c.plan_value) > VALUE_EPSILON;
      const planChanged = prev.price_ids !== c.price_ids;
      if (!valueChanged && !planChanged) continue; // nothing changed

      // Currency-only differences (e.g. a customer's subscription is re-priced in a
      // different currency but at an equivalent tier) are logged but explicitly kept
      // OUT of Upgrade/Downgrade — the ask was to ignore forex-driven noise.
      const changeType = !sameCurrency
        ? "Currency Switch"
        : c.plan_value > prev.plan_value
          ? "Upgrade"
          : c.plan_value < prev.plan_value
            ? "Downgrade"
            : "Plan Changed"; // same value, different price IDs (e.g. renamed plan)

      newChanges.push({
        detected_at: nowIso,
        customer_id: c.customer_id,
        account: c.account,
        customer_name: c.customer_name,
        domain: c.domain,
        business: c.business,
        cs_email: c.cs_email,
        change_type: changeType,
        previous_value: prev.plan_value,
        new_value: c.plan_value,
        previous_currency: prev.currency,
        new_currency: c.currency,
        previous_plan: prev.plan_summary,
        new_plan: c.plan_summary,
      });
    }

    if (newChanges.length) {
      await appendPlanChanges(newChanges).catch((err) =>
        console.warn("[/api/plan-changes] Failed to append change log:", err.message)
      );
    }

    const snapshotRows: PlanSnapshotRow[] = current.map((c: CustomerPlanSnapshot) => ({
      customer_id: c.customer_id,
      account: c.account,
      currency: c.currency,
      plan_value: c.plan_value,
      price_ids: c.price_ids,
      plan_summary: c.plan_summary,
      checked_at: nowIso,
    }));
    await writePlanSnapshots(snapshotRows).catch((err) =>
      console.warn("[/api/plan-changes] Failed to write snapshot:", err.message)
    );

    const history = await readPlanChanges().catch(() => newChanges);

    return NextResponse.json({ changes: history, asOf: nowIso, newly_detected: newChanges.length });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[/api/plan-changes]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
