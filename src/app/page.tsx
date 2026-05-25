"use client";

import { useEffect, useState, useMemo } from "react";
import type { InvoiceRow, CustomerDSO, AgingBucket } from "@/lib/stripe";

// ─── Types ────────────────────────────────────────────────────────────────────
interface ApiResponse {
  invoices: InvoiceRow[];
  dso: CustomerDSO[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function fmtCurrency(amount: number, currency: string) {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(amount);
}

function agingColor(bucket: AgingBucket): string {
  const map: Record<AgingBucket, string> = {
    "0-30": "#22c55e",
    "31-60": "#f59e0b",
    "61-90": "#f97316",
    "90+": "#ef4444",
  };
  return map[bucket];
}

const BUCKETS: AgingBucket[] = ["0-30", "31-60", "61-90", "90+"];

// ─── Sub-components ───────────────────────────────────────────────────────────
function StatCard({
  label,
  value,
  sub,
  color,
}: {
  label: string;
  value: string;
  sub?: string;
  color?: string;
}) {
  return (
    <div style={styles.card}>
      <div style={{ fontSize: 13, color: "#6b7280", marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 700, color: color ?? "#1a1a2e" }}>
        {value}
      </div>
      {sub && <div style={{ fontSize: 12, color: "#9ca3af", marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function Badge({ bucket }: { bucket: AgingBucket }) {
  const color = agingColor(bucket);
  return (
    <span
      style={{
        background: color + "22",
        color,
        border: `1px solid ${color}55`,
        borderRadius: 4,
        padding: "2px 8px",
        fontSize: 12,
        fontWeight: 600,
        whiteSpace: "nowrap",
      }}
    >
      {bucket} days
    </span>
  );
}

function BizBadge({ type }: { type: string }) {
  if (!type) return <span style={{ color: "#9ca3af", fontSize: 12 }}>—</span>;
  // Generate a stable color from the type string
  const colors = [
    ["#3b82f6", "#eff6ff"],
    ["#8b5cf6", "#f5f3ff"],
    ["#06b6d4", "#ecfeff"],
    ["#10b981", "#f0fdf4"],
    ["#f59e0b", "#fffbeb"],
    ["#ec4899", "#fdf2f8"],
  ];
  const idx =
    type.split("").reduce((acc, ch) => acc + ch.charCodeAt(0), 0) % colors.length;
  const [fg, bg] = colors[idx];
  return (
    <span
      style={{
        background: bg,
        color: fg,
        border: `1px solid ${fg}33`,
        borderRadius: 4,
        padding: "2px 8px",
        fontSize: 12,
        fontWeight: 600,
        whiteSpace: "nowrap",
      }}
    >
      {type}
    </span>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────
export default function Dashboard() {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportMsg, setExportMsg] = useState<string | null>(null);

  // Filters
  const [accountFilter, setAccountFilter] = useState<"All" | "India" | "US">("All");
  const [bucketFilter, setBucketFilter] = useState<AgingBucket | "All">("All");
  const [bizFilter, setBizFilter] = useState<string>("All");
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<"invoices" | "dso">("invoices");
  const [sortKey, setSortKey] = useState<keyof InvoiceRow>("days_overdue");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  useEffect(() => {
    fetch("/api/invoices")
      .then((r) => r.json())
      .then((d) => {
        if (d.error) throw new Error(d.error);
        setData(d);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  // Unique business types for the filter dropdown
  const bizTypes = useMemo(() => {
    if (!data) return [];
    const types = new Set(
      data.invoices.map((i) => i.business_type).filter(Boolean)
    );
    return Array.from(types).sort();
  }, [data]);

  const invoices = useMemo(() => {
    if (!data) return [];
    return data.invoices
      .filter((inv) => {
        if (accountFilter !== "All" && inv.account !== accountFilter) return false;
        if (bucketFilter !== "All" && inv.aging_bucket !== bucketFilter) return false;
        if (bizFilter !== "All" && inv.business_type !== bizFilter) return false;
        if (search) {
          const q = search.toLowerCase();
          if (
            !inv.customer_name.toLowerCase().includes(q) &&
            !inv.customer_email.toLowerCase().includes(q) &&
            !inv.invoice_number.toLowerCase().includes(q) &&
            !(inv.business_type ?? "").toLowerCase().includes(q)
          )
            return false;
        }
        return true;
      })
      .sort((a, b) => {
        const av = a[sortKey];
        const bv = b[sortKey];
        const cmp =
          typeof av === "number" && typeof bv === "number"
            ? av - bv
            : String(av ?? "").localeCompare(String(bv ?? ""));
        return sortDir === "asc" ? cmp : -cmp;
      });
  }, [data, accountFilter, bucketFilter, bizFilter, search, sortKey, sortDir]);

  const dso = useMemo(() => {
    if (!data) return [];
    return data.dso.filter((d) => {
      if (accountFilter !== "All" && d.account !== accountFilter) return false;
      if (bizFilter !== "All" && d.business_type !== bizFilter) return false;
      if (search) {
        const q = search.toLowerCase();
        if (
          !d.customer_name.toLowerCase().includes(q) &&
          !d.customer_email.toLowerCase().includes(q) &&
          !(d.business_type ?? "").toLowerCase().includes(q)
        )
          return false;
      }
      return true;
    });
  }, [data, accountFilter, bizFilter, search]);

  // Summary stats
  const totalOutstanding = useMemo(
    () => invoices.reduce((s, i) => s + i.amount_due, 0),
    [invoices]
  );
  const pastDueCount = useMemo(
    () => invoices.filter((i) => i.days_overdue > 0).length,
    [invoices]
  );
  const agingTotals = useMemo(() => {
    const m: Record<AgingBucket, number> = {
      "0-30": 0,
      "31-60": 0,
      "61-90": 0,
      "90+": 0,
    };
    invoices.forEach((i) => (m[i.aging_bucket] += i.amount_due));
    return m;
  }, [invoices]);

  function toggleSort(key: keyof InvoiceRow) {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setSortDir("desc"); }
  }

  async function handleExport() {
    setExporting(true);
    setExportMsg(null);
    try {
      const r = await fetch("/api/export", { method: "POST" });
      const j = await r.json();
      if (j.error) throw new Error(j.error);
      setExportMsg(`✅ Exported! View sheet → ${j.url}`);
    } catch (e: unknown) {
      setExportMsg(`❌ ${e instanceof Error ? e.message : "Export failed"}`);
    } finally {
      setExporting(false);
    }
  }

  // ── Render states ──────────────────────────────────────────────────────────
  if (loading)
    return (
      <div style={styles.center}>
        <div style={styles.spinner} />
        <p style={{ marginTop: 16, color: "#6b7280" }}>Loading invoices from Stripe…</p>
      </div>
    );

  if (error)
    return (
      <div style={styles.center}>
        <div style={{ color: "#ef4444", fontSize: 18, fontWeight: 600 }}>⚠ Error</div>
        <p style={{ marginTop: 8, color: "#6b7280" }}>{error}</p>
      </div>
    );

  // ── Main render ────────────────────────────────────────────────────────────
  return (
    <div style={styles.page}>
      {/* Header */}
      <div style={styles.header}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: "#fff" }}>
            📄 Outstanding Invoices
          </h1>
          <p style={{ fontSize: 13, color: "#cbd5e1", marginTop: 2 }}>
            India &amp; US Stripe accounts · Open &amp; past-due only
          </p>
        </div>
        <button
          onClick={handleExport}
          disabled={exporting}
          style={styles.exportBtn}
        >
          {exporting ? "Exporting…" : "⬆ Export to Google Sheets"}
        </button>
      </div>

      {exportMsg && (
        <div style={styles.exportMsg}>
          {exportMsg.startsWith("✅") ? (
            <a href={exportMsg.split("→ ")[1]} target="_blank" rel="noreferrer">
              {exportMsg}
            </a>
          ) : (
            exportMsg
          )}
        </div>
      )}

      {/* Stat cards */}
      <div style={styles.statsRow}>
        <StatCard
          label="Total Outstanding"
          value={fmtCurrency(totalOutstanding, invoices[0]?.currency ?? "USD")}
          sub={`${invoices.length} invoices`}
          color="#6366f1"
        />
        <StatCard
          label="Past Due"
          value={String(pastDueCount)}
          sub="invoices overdue"
          color="#ef4444"
        />
        {BUCKETS.map((b) => (
          <StatCard
            key={b}
            label={`${b} days`}
            value={fmtCurrency(agingTotals[b], invoices[0]?.currency ?? "USD")}
            color={agingColor(b)}
          />
        ))}
      </div>

      {/* Filters */}
      <div style={styles.filterBar}>
        <input
          style={styles.searchInput}
          placeholder="Search customer, email, invoice #, biz type…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          style={styles.select}
          value={accountFilter}
          onChange={(e) => setAccountFilter(e.target.value as "All" | "India" | "US")}
        >
          <option value="All">All Accounts</option>
          <option value="India">India</option>
          <option value="US">US</option>
        </select>
        <select
          style={styles.select}
          value={bucketFilter}
          onChange={(e) => setBucketFilter(e.target.value as AgingBucket | "All")}
        >
          <option value="All">All Aging</option>
          {BUCKETS.map((b) => (
            <option key={b} value={b}>{b} days</option>
          ))}
        </select>
        {bizTypes.length > 0 && (
          <select
            style={styles.select}
            value={bizFilter}
            onChange={(e) => setBizFilter(e.target.value)}
          >
            <option value="All">All Business Types</option>
            {bizTypes.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        )}

        {/* Tabs */}
        <div style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
          {(["invoices", "dso"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              style={{
                ...styles.tabBtn,
                background: tab === t ? "#6366f1" : "#e5e7eb",
                color: tab === t ? "#fff" : "#374151",
              }}
            >
              {t === "invoices" ? "📋 Invoices" : "📊 DSO by Customer"}
            </button>
          ))}
        </div>
      </div>

      {/* Tables */}
      <div style={styles.tableWrapper}>
        {tab === "invoices" ? (
          <table style={styles.table}>
            <thead>
              <tr style={{ background: "#f8fafc" }}>
                {(
                  [
                    ["account", "Account"],
                    ["invoice_number", "Invoice #"],
                    ["customer_name", "Customer"],
                    ["business_type", "Biz Type"],
                    ["amount_due", "Amount Due"],
                    ["due_date", "Due Date"],
                    ["days_overdue", "Days Overdue"],
                    ["aging_bucket", "Aging"],
                    ["status", "Status"],
                  ] as [keyof InvoiceRow, string][]
                ).map(([key, label]) => (
                  <th
                    key={key}
                    onClick={() => toggleSort(key)}
                    style={styles.th}
                  >
                    {label}{" "}
                    {sortKey === key ? (sortDir === "asc" ? "↑" : "↓") : ""}
                  </th>
                ))}
                <th style={styles.th}>Link</th>
              </tr>
            </thead>
            <tbody>
              {invoices.length === 0 ? (
                <tr>
                  <td colSpan={10} style={{ textAlign: "center", padding: 40, color: "#9ca3af" }}>
                    No invoices found for the selected filters.
                  </td>
                </tr>
              ) : (
                invoices.map((inv, i) => (
                  <tr
                    key={inv.id}
                    style={{ background: i % 2 === 0 ? "#fff" : "#f9fafb" }}
                  >
                    <td style={styles.td}>
                      <span style={{
                        background: inv.account === "India" ? "#818cf822" : "#34d39922",
                        color: inv.account === "India" ? "#4f46e5" : "#059669",
                        padding: "2px 8px",
                        borderRadius: 4,
                        fontSize: 12,
                        fontWeight: 600,
                      }}>
                        {inv.account}
                      </span>
                    </td>
                    <td style={styles.td}>
                      <span style={{ fontFamily: "monospace", fontSize: 13 }}>
                        {inv.invoice_number}
                      </span>
                    </td>
                    <td style={styles.td}>
                      <div style={{ fontWeight: 500 }}>{inv.customer_name}</div>
                      <div style={{ fontSize: 12, color: "#9ca3af" }}>{inv.customer_email}</div>
                    </td>
                    <td style={styles.td}>
                      <BizBadge type={inv.business_type} />
                    </td>
                    <td style={{ ...styles.td, fontWeight: 600 }}>
                      {fmtCurrency(inv.amount_due, inv.currency)}
                    </td>
                    <td style={styles.td}>{inv.due_date ?? "—"}</td>
                    <td style={{
                      ...styles.td,
                      color: inv.days_overdue > 0 ? "#ef4444" : "#22c55e",
                      fontWeight: 600,
                    }}>
                      {inv.days_overdue > 0 ? `${inv.days_overdue}d` : "Not due"}
                    </td>
                    <td style={styles.td}><Badge bucket={inv.aging_bucket} /></td>
                    <td style={styles.td}>
                      <span style={{
                        background: "#f3f4f6",
                        borderRadius: 4,
                        padding: "2px 6px",
                        fontSize: 12,
                      }}>
                        {inv.status}
                      </span>
                    </td>
                    <td style={styles.td}>
                      {inv.invoice_url ? (
                        <a
                          href={inv.invoice_url}
                          target="_blank"
                          rel="noreferrer"
                          style={{ color: "#6366f1", fontSize: 13 }}
                        >
                          View ↗
                        </a>
                      ) : "—"}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        ) : (
          <table style={styles.table}>
            <thead>
              <tr style={{ background: "#f8fafc" }}>
                {["Account", "Customer", "Biz Type", "Currency", "Total Outstanding", "DSO (Days)", "Invoices"].map((h) => (
                  <th key={h} style={styles.th}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {dso.length === 0 ? (
                <tr>
                  <td colSpan={7} style={{ textAlign: "center", padding: 40, color: "#9ca3af" }}>
                    No data.
                  </td>
                </tr>
              ) : (
                dso.map((d, i) => (
                  <tr key={d.customer_id + d.account} style={{ background: i % 2 === 0 ? "#fff" : "#f9fafb" }}>
                    <td style={styles.td}>
                      <span style={{
                        background: d.account === "India" ? "#818cf822" : "#34d39922",
                        color: d.account === "India" ? "#4f46e5" : "#059669",
                        padding: "2px 8px",
                        borderRadius: 4,
                        fontSize: 12,
                        fontWeight: 600,
                      }}>
                        {d.account}
                      </span>
                    </td>
                    <td style={styles.td}>
                      <div style={{ fontWeight: 500 }}>{d.customer_name}</div>
                      <div style={{ fontSize: 12, color: "#9ca3af" }}>{d.customer_email}</div>
                    </td>
                    <td style={styles.td}><BizBadge type={d.business_type} /></td>
                    <td style={styles.td}>{d.currency}</td>
                    <td style={{ ...styles.td, fontWeight: 600 }}>
                      {fmtCurrency(d.total_outstanding, d.currency)}
                    </td>
                    <td style={{
                      ...styles.td,
                      fontWeight: 600,
                      color: d.dso_days > 60 ? "#ef4444" : d.dso_days > 30 ? "#f59e0b" : "#22c55e",
                    }}>
                      {d.dso_days}d
                    </td>
                    <td style={styles.td}>{d.invoice_count}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        )}
      </div>

      <div style={{ textAlign: "center", padding: "16px 0", color: "#9ca3af", fontSize: 12 }}>
        Data refreshes every 5 minutes · Paid, void, draft &amp; uncollectible invoices excluded
      </div>
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const styles = {
  page: {
    maxWidth: 1400,
    margin: "0 auto",
    padding: "24px 20px",
  } as React.CSSProperties,
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    background: "linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%)",
    borderRadius: 12,
    padding: "20px 28px",
    marginBottom: 20,
  } as React.CSSProperties,
  exportBtn: {
    background: "#fff",
    color: "#4f46e5",
    border: "none",
    borderRadius: 8,
    padding: "10px 20px",
    fontWeight: 600,
    fontSize: 14,
    cursor: "pointer",
    whiteSpace: "nowrap",
  } as React.CSSProperties,
  exportMsg: {
    background: "#f0fdf4",
    border: "1px solid #bbf7d0",
    borderRadius: 8,
    padding: "10px 16px",
    marginBottom: 16,
    fontSize: 13,
    color: "#166534",
  } as React.CSSProperties,
  statsRow: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
    gap: 12,
    marginBottom: 20,
  } as React.CSSProperties,
  card: {
    background: "#fff",
    borderRadius: 10,
    padding: "16px 20px",
    boxShadow: "0 1px 3px rgba(0,0,0,0.07)",
  } as React.CSSProperties,
  filterBar: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    marginBottom: 16,
    flexWrap: "wrap" as const,
  } as React.CSSProperties,
  searchInput: {
    border: "1px solid #d1d5db",
    borderRadius: 8,
    padding: "8px 12px",
    fontSize: 14,
    width: 280,
    outline: "none",
  } as React.CSSProperties,
  select: {
    border: "1px solid #d1d5db",
    borderRadius: 8,
    padding: "8px 12px",
    fontSize: 14,
    background: "#fff",
    cursor: "pointer",
  } as React.CSSProperties,
  tabBtn: {
    border: "none",
    borderRadius: 8,
    padding: "8px 14px",
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
  } as React.CSSProperties,
  tableWrapper: {
    background: "#fff",
    borderRadius: 10,
    boxShadow: "0 1px 3px rgba(0,0,0,0.07)",
    overflow: "auto",
  } as React.CSSProperties,
  table: {
    width: "100%",
    borderCollapse: "collapse" as const,
    fontSize: 14,
  } as React.CSSProperties,
  th: {
    textAlign: "left" as const,
    padding: "12px 16px",
    fontWeight: 600,
    fontSize: 13,
    color: "#374151",
    cursor: "pointer",
    userSelect: "none" as const,
    borderBottom: "2px solid #e5e7eb",
    whiteSpace: "nowrap" as const,
  } as React.CSSProperties,
  td: {
    padding: "12px 16px",
    borderBottom: "1px solid #f3f4f6",
    verticalAlign: "middle" as const,
  } as React.CSSProperties,
  center: {
    display: "flex",
    flexDirection: "column" as const,
    alignItems: "center",
    justifyContent: "center",
    height: "100vh",
    gap: 8,
  } as React.CSSProperties,
  spinner: {
    width: 36,
    height: 36,
    border: "4px solid #e5e7eb",
    borderTop: "4px solid #6366f1",
    borderRadius: "50%",
    animation: "spin 0.8s linear infinite",
  } as React.CSSProperties,
};
