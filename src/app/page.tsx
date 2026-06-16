"use client";
import { useEffect, useState, useMemo, useCallback } from "react";
import type { InvoiceRow, AgingBucket } from "@/lib/stripe";

// ── API interfaces ─────────────────────────────────────────────────────────────
interface InvoiceRowWithUsd extends InvoiceRow { amount_usd: number; }
interface CustomerDSOWithUsd {
  customer_id: string;
  account: "India" | "US";
  total_outstanding_usd: number;
  total_sales_12m_usd: number;
  sales_3m_usd: number;
  dso_days: number;
  collection_method: "charge_automatically" | "send_invoice";
}
interface ApiResponse {
  invoices: InvoiceRowWithUsd[];
  dso: CustomerDSOWithUsd[];
  inrPerUsd: number;
}

// ── Row built from invoices ───────────────────────────────────────────────────
interface CustRow {
  key: string;
  customer_name: string; customer_email: string;
  domain: string; customer_status: string;
  business: string; cs_email: string; account: "India" | "US";
  b0_30: number; b31_60: number; b61_90: number;
  b90_180: number; b180plus: number;
  total: number; invoice_count: number; dso_days: number;
  collection_method: "charge_automatically" | "send_invoice";
  sales_3m_usd: number;
}

// ── Formatting / colour helpers ───────────────────────────────────────────────
const fmtUSD = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);

const AGING_COLORS: Record<AgingBucket, string> = {
  "0-30":   "#10b981",
  "31-60":  "#f59e0b",
  "61-90":  "#f97316",
  "90-180": "#ef4444",
  "180+":   "#7c3aed",
};
const agingColor = (b: AgingBucket) => AGING_COLORS[b];
const BUCKETS: AgingBucket[] = ["0-30", "31-60", "61-90", "90-180", "180+"];

function statusStyle(s: string): React.CSSProperties {
  const base: React.CSSProperties = { borderRadius: 20, padding: "3px 10px", fontSize: 11, fontWeight: 700, display: "inline-block" };
  if (s === "Active")   return { ...base, color: "#065f46", background: "#d1fae5", border: "1px solid #6ee7b7" };
  if (s === "Inactive") return { ...base, color: "#92400e", background: "#fef3c7", border: "1px solid #fcd34d" };
  if (s === "Churned")  return { ...base, color: "#7f1d1d", background: "#fee2e2", border: "1px solid #fca5a5" };
  return { ...base, color: "#374151", background: "#f3f4f6", border: "1px solid #d1d5db" };
}

const BIZ_PALETTE: [string, string, string][] = [
  ["#4f46e5", "#eef2ff", "#c7d2fe"],
  ["#7c3aed", "#f5f3ff", "#ddd6fe"],
  ["#0891b2", "#ecfeff", "#a5f3fc"],
  ["#059669", "#ecfdf5", "#6ee7b7"],
  ["#d97706", "#fffbeb", "#fde68a"],
  ["#db2777", "#fdf2f8", "#fbcfe8"],
];
function bizColor(text: string): [string, string, string] {
  const idx = text.split("").reduce((a, c) => a + c.charCodeAt(0), 0) % BIZ_PALETTE.length;
  return BIZ_PALETTE[idx];
}
const acctStyle = (a: string): React.CSSProperties =>
  a === "India"
    ? { background: "#eef2ff", color: "#4338ca", padding: "3px 10px", borderRadius: 20, fontSize: 11, fontWeight: 700, border: "1px solid #c7d2fe" }
    : { background: "#ecfdf5", color: "#047857", padding: "3px 10px", borderRadius: 20, fontSize: 11, fontWeight: 700, border: "1px solid #6ee7b7" };

function dsoColor(d: number) {
  if (d > 90) return "#ef4444";
  if (d > 60) return "#f97316";
  if (d > 30) return "#f59e0b";
  return "#10b981";
}
function dsoBg(d: number) {
  if (d > 90) return "#fee2e2";
  if (d > 60) return "#ffedd5";
  if (d > 30) return "#fef9c3";
  return "#d1fae5";
}

// ── Component ─────────────────────────────────────────────────────────────────
export default function Dashboard() {
  const [data, setData]               = useState<ApiResponse | null>(null);
  const [loading, setLoading]         = useState(true);
  const [refreshing, setRefreshing]   = useState(false);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [error, setError]             = useState<string | null>(null);
  const [exporting, setExp]           = useState(false);
  const [sending, setSending]         = useState(false);
  const [msg, setMsg]                 = useState<string | null>(null);
  const [expanded, setExpanded]       = useState<Set<string>>(new Set());
  const [sortCol, setSortCol]         = useState<keyof CustRow>("total");
  const [sortDir, setSortDir]         = useState<"asc" | "desc">("desc");
  const [activeTab, setActiveTab]     = useState<"all" | "active" | "inactive">("all");

  // Filters
  const [search,    setSearch]    = useState("");
  const [acctF,     setAcctF]     = useState("All");
  const [statF,     setStatF]     = useState("All");
  const [bizF,      setBizF]      = useState("All");
  const [csF,       setCsF]       = useState("All");
  const [b0_30F,    setB0_30F]    = useState("All");
  const [b31_60F,   setB31_60F]   = useState("All");
  const [b61_90F,   setB61_90F]   = useState("All");
  const [b90_180F,  setB90_180F]  = useState("All");
  const [b180plusF, setB180plusF] = useState("All");
  const [dsoF,      setDsoF]      = useState("All");
  const [totalF,    setTotalF]    = useState("All");
  const [pmF,       setPmF]       = useState("All"); // payment mode filter

  const loadData = useCallback((isRefresh = false) => {
    if (isRefresh) setRefreshing(true); else setLoading(true);
    setError(null);
    fetch("/api/invoices")
      .then(r => r.json())
      .then(d => {
        if (d.error) throw new Error(d.error);
        setData(d);
        setLastUpdated(new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
      })
      .catch(e => setError(e.message))
      .finally(() => { setLoading(false); setRefreshing(false); });
  }, []);

  useEffect(() => { loadData(false); }, [loadData]);

  const allInvoices = useMemo(() => data?.invoices ?? [], [data]);

  // DSO data map — keyed by "account::customer_id"
  const dsoDataMap = useMemo(() => {
    const m = new Map<string, CustomerDSOWithUsd>();
    for (const d of data?.dso ?? []) m.set(`${d.account}::${d.customer_id}`, d);
    return m;
  }, [data]);

  // ── Cascading filter options ────────────────────────────────────────────────
  // Each dropdown's options are derived from invoices matching ALL OTHER active
  // filters, so selecting Business=Services only shows CS owners in Services.
  const bizTypeOptions = useMemo(() =>
    Array.from(new Set(
      allInvoices
        .filter(i => acctF === "All" || i.account === acctF)
        .filter(i => statF === "All" || i.customer_status === statF)
        .filter(i => csF   === "All" || i.cs_email === csF)
        .map(i => i.business).filter(Boolean)
    )).sort(), [allInvoices, acctF, statF, csF]);

  const csEmailOptions = useMemo(() =>
    Array.from(new Set(
      allInvoices
        .filter(i => acctF === "All" || i.account === acctF)
        .filter(i => statF === "All" || i.customer_status === statF)
        .filter(i => bizF  === "All" || i.business === bizF)
        .map(i => i.cs_email).filter(Boolean)
    )).sort(), [allInvoices, acctF, statF, bizF]);

  const statusOptions = useMemo(() =>
    Array.from(new Set(
      allInvoices
        .filter(i => acctF === "All" || i.account === acctF)
        .filter(i => bizF  === "All" || i.business === bizF)
        .filter(i => csF   === "All" || i.cs_email === csF)
        .map(i => i.customer_status).filter(Boolean)
    )).sort(), [allInvoices, acctF, bizF, csF]);

  // ── Customer rows (aggregated from invoice-level) ──────────────────────────
  const custRows = useMemo(() => {
    const map = new Map<string, CustRow>();

    for (const inv of allInvoices) {
      if (acctF !== "All" && inv.account !== acctF) continue;
      if (bizF  !== "All" && inv.business !== bizF) continue;
      if (csF   !== "All" && inv.cs_email !== csF)  continue;
      if (statF !== "All" && inv.customer_status !== statF) continue;
      if (search) {
        const q = search.toLowerCase();
        if (![inv.customer_name, inv.customer_email, inv.domain, inv.business, inv.cs_email]
            .some(v => v?.toLowerCase().includes(q))) continue;
      }
      // Tab pre-filter
      if (activeTab === "active"   && inv.customer_status !== "Active")   continue;
      if (activeTab === "inactive" && inv.customer_status !== "Inactive") continue;
      if (pmF === "auto"   && inv.collection_method !== "charge_automatically") continue;
      if (pmF === "manual" && inv.collection_method !== "send_invoice")         continue;

      const key = `${inv.account}::${inv.customer_id}`;
      if (!map.has(key)) {
        const dsoData = dsoDataMap.get(key);
        map.set(key, {
          key,
          customer_name:   inv.customer_name,
          customer_email:  inv.customer_email,
          domain:          inv.domain,
          customer_status: inv.customer_status,
          business:        inv.business,
          cs_email:        inv.cs_email,
          account:         inv.account,
          b0_30: 0, b31_60: 0, b61_90: 0, b90_180: 0, b180plus: 0,
          total: 0, invoice_count: 0, dso_days: 0,
          collection_method: dsoData?.collection_method ?? inv.collection_method,
          sales_3m_usd: dsoData?.sales_3m_usd ?? 0,
        });
      }
      const r = map.get(key)!;
      r.total += inv.amount_usd;
      r.invoice_count++;
      if      (inv.aging_bucket === "0-30")   r.b0_30   += inv.amount_usd;
      else if (inv.aging_bucket === "31-60")  r.b31_60  += inv.amount_usd;
      else if (inv.aging_bucket === "61-90")  r.b61_90  += inv.amount_usd;
      else if (inv.aging_bucket === "90-180") r.b90_180 += inv.amount_usd;
      else                                    r.b180plus += inv.amount_usd;
    }

    return Array.from(map.values())
      .map(r => ({ ...r, dso_days: dsoDataMap.get(r.key)?.dso_days ?? 0 }))
      .filter(r => {
        if (b0_30F    === "Has balance" && r.b0_30    <= 0) return false;
        if (b31_60F   === "Has balance" && r.b31_60   <= 0) return false;
        if (b61_90F   === "Has balance" && r.b61_90   <= 0) return false;
        if (b90_180F  === "Has balance" && r.b90_180  <= 0) return false;
        if (b180plusF === "Has balance" && r.b180plus <= 0) return false;
        if (dsoF === "0–30d"   && !(r.dso_days <= 30))                      return false;
        if (dsoF === "31–60d"  && !(r.dso_days > 30 && r.dso_days <= 60))  return false;
        if (dsoF === "61–90d"  && !(r.dso_days > 60 && r.dso_days <= 90))  return false;
        if (dsoF === ">90d"    && !(r.dso_days > 90))                        return false;
        if (totalF === "<$1k"    && !(r.total < 1000))                       return false;
        if (totalF === "$1k–5k"  && !(r.total >= 1000 && r.total < 5000))   return false;
        if (totalF === "$5k–20k" && !(r.total >= 5000 && r.total < 20000))  return false;
        if (totalF === ">$20k"   && !(r.total >= 20000))                     return false;
        return true;
      })
      .sort((a, b) => {
        const av = a[sortCol], bv = b[sortCol];
        const cmp = typeof av === "number" && typeof bv === "number"
          ? av - bv
          : String(av ?? "").localeCompare(String(bv ?? ""));
        return sortDir === "asc" ? cmp : -cmp;
      });
  }, [allInvoices, dsoDataMap, acctF, bizF, csF, statF, search, activeTab, pmF,
      b0_30F, b31_60F, b61_90F, b90_180F, b180plusF, dsoF, totalF, sortCol, sortDir]);

  const invoicesByKey = useMemo(() => {
    const m = new Map<string, InvoiceRowWithUsd[]>();
    for (const inv of allInvoices) {
      const k = `${inv.account}::${inv.customer_id}`;
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(inv);
    }
    return m;
  }, [allInvoices]);

  // ── Derived stats ──────────────────────────────────────────────────────────
  const grandTotal   = useMemo(() => custRows.reduce((s, r) => s + r.total, 0), [custRows]);
  const pastDueCnt   = useMemo(() => custRows.filter(r => r.b31_60 + r.b61_90 + r.b90_180 + r.b180plus > 0).length, [custRows]);
  const agingTot     = useMemo(() => {
    const m: Record<AgingBucket, number> = { "0-30": 0, "31-60": 0, "61-90": 0, "90-180": 0, "180+": 0 };
    custRows.forEach(r => { m["0-30"] += r.b0_30; m["31-60"] += r.b31_60; m["61-90"] += r.b61_90; m["90-180"] += r.b90_180; m["180+"] += r.b180plus; });
    return m;
  }, [custRows]);

  const aggregateDSO = useMemo(() => {
    const withDso = custRows.filter(r => r.dso_days > 0);
    const totalAmt = withDso.reduce((s, r) => s + r.total, 0);
    if (totalAmt === 0) return 0;
    return Math.round(withDso.reduce((s, r) => s + r.dso_days * r.total, 0) / totalAmt);
  }, [custRows]);

  // Business-type breakdown with payment mode stats
  const bizStats = useMemo(() => {
    const map = new Map<string, {
      total: number; count: number; dsoW: number;
      b0_30: number; b31_60: number; b61_90: number; b90_180: number; b180plus: number;
      autoPay: number; manualPay: number; sales_3m: number;
    }>();
    for (const r of custRows) {
      const biz = r.business || "Other";
      if (!map.has(biz)) map.set(biz, { total: 0, count: 0, dsoW: 0, b0_30: 0, b31_60: 0, b61_90: 0, b90_180: 0, b180plus: 0, autoPay: 0, manualPay: 0, sales_3m: 0 });
      const b = map.get(biz)!;
      b.total += r.total; b.count++;
      if (r.dso_days > 0) b.dsoW += r.dso_days * r.total;
      b.b0_30 += r.b0_30; b.b31_60 += r.b31_60; b.b61_90 += r.b61_90; b.b90_180 += r.b90_180; b.b180plus += r.b180plus;
      if (r.collection_method === "charge_automatically") b.autoPay++; else b.manualPay++;
      b.sales_3m += r.sales_3m_usd;
    }
    return Array.from(map.entries()).map(([biz, v]) => ({
      biz,
      total: v.total, count: v.count,
      dso: v.total > 0 ? Math.round(v.dsoW / v.total) : 0,
      b0_30: v.b0_30, b31_60: v.b31_60, b61_90: v.b61_90, b90_180: v.b90_180, b180plus: v.b180plus,
      autoPay: v.autoPay, manualPay: v.manualPay,
      autoPayPct: v.count > 0 ? Math.round(v.autoPay / v.count * 100) : 0,
      manualPayPct: v.count > 0 ? Math.round(v.manualPay / v.count * 100) : 0,
      sales_3m: v.sales_3m,
    })).sort((a, b) => b.total - a.total);
  }, [custRows]);

  // ── Actions ────────────────────────────────────────────────────────────────
  function toggleSort(k: keyof CustRow) {
    if (sortCol === k) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortCol(k); setSortDir("desc"); }
  }
  function toggleExpand(key: string) {
    setExpanded(prev => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; });
  }
  function resetFilters() {
    setSearch(""); setAcctF("All"); setStatF("All"); setBizF("All"); setCsF("All"); setPmF("All");
    setB0_30F("All"); setB31_60F("All"); setB61_90F("All"); setB90_180F("All"); setB180plusF("All");
    setDsoF("All"); setTotalF("All");
  }
  const hasActiveFilters = !!(search || acctF !== "All" || statF !== "All" || bizF !== "All" || csF !== "All"
    || pmF !== "All" || b0_30F !== "All" || b31_60F !== "All" || b61_90F !== "All" || b90_180F !== "All"
    || b180plusF !== "All" || dsoF !== "All" || totalF !== "All");

  async function doExport() {
    setExp(true); setMsg(null);
    try { const r = await fetch("/api/export", { method: "POST" }); const j = await r.json(); if (j.error) throw new Error(j.error); setMsg("✓ Exported to Sheets"); }
    catch (e: unknown) { setMsg(`Export error: ${e instanceof Error ? e.message : "failed"}`); }
    finally { setExp(false); }
  }
  async function doSend() {
    setSending(true); setMsg(null);
    try { const r = await fetch("/api/send-reminders", { method: "POST" }); const j = await r.json(); if (j.error) throw new Error(j.error); setMsg(`✓ Sent ${j.total_emails} emails`); }
    catch (e: unknown) { setMsg(`Send error: ${e instanceof Error ? e.message : "failed"}`); }
    finally { setSending(false); }
  }

  // ── Sub-components ─────────────────────────────────────────────────────────
  const sel: React.CSSProperties = { fontSize: 11, border: "1px solid #e2e8f0", borderRadius: 6, padding: "4px 6px", background: "#fff", cursor: "pointer", width: "100%", color: "#374151" };
  const FTh = ({ children }: { children?: React.ReactNode }) =>
    <th style={{ padding: "4px 14px 8px", borderBottom: "2px solid #e2e8f0", background: "#f8fafc" }}>{children}</th>;
  const Th = ({ label, col, color }: { label: string; col: keyof CustRow; color?: string }) => (
    <th onClick={() => toggleSort(col)} style={{ ...S.th, color: color ?? "#475569", cursor: "pointer", userSelect: "none" }}>
      {label}{sortCol === col ? (sortDir === "asc" ? " ↑" : " ↓") : ""}
    </th>
  );

  const bucketCount = (r: CustRow, b: AgingBucket) => {
    if (b === "0-30")   return r.b0_30;
    if (b === "31-60")  return r.b31_60;
    if (b === "61-90")  return r.b61_90;
    if (b === "90-180") return r.b90_180;
    return r.b180plus;
  };

  // ── Loading / Error ────────────────────────────────────────────────────────
  if (loading) return (
    <div style={S.center}>
      <div style={S.spin} />
      <p style={{ marginTop: 16, color: "#64748b", fontSize: 15 }}>Loading invoices from Stripe...</p>
    </div>
  );
  if (error) return (
    <div style={S.center}>
      <div style={{ fontSize: 40, marginBottom: 8 }}>⚠️</div>
      <div style={{ color: "#ef4444", fontSize: 18, fontWeight: 700 }}>Something went wrong</div>
      <p style={{ color: "#64748b", marginTop: 8 }}>{error}</p>
    </div>
  );

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div style={S.page}>

      {/* ── HEADER ── */}
      <div style={S.header}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
            <span style={{ fontSize: 26 }}>📊</span>
            <h1 style={{ fontSize: 24, fontWeight: 800, color: "#fff", margin: 0, letterSpacing: -0.5 }}>Outstanding Invoices</h1>
          </div>
          <p style={{ fontSize: 13, color: "#94a3b8", margin: 0 }}>
            Customer-wise · India + US · USD · 1 USD = {data?.inrPerUsd} INR
            {lastUpdated && <span style={{ marginLeft: 10, color: "#64748b" }}>· Updated {lastUpdated}</span>}
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button onClick={() => loadData(true)} disabled={refreshing} style={S.ghostBtn}>{refreshing ? "⟳ Refreshing..." : "⟳ Refresh"}</button>
          <button onClick={doSend} disabled={sending} style={S.ghostBtn}>{sending ? "Sending..." : "✉ CS Reminders"}</button>
          <button onClick={doExport} disabled={exporting} style={S.exportBtn}>{exporting ? "Exporting..." : "↑ Export"}</button>
        </div>
      </div>

      {msg && <div style={S.toast}>{msg}</div>}

      {/* ── TABS ── */}
      <div style={S.tabBar}>
        {(["all", "active", "inactive"] as const).map(t => (
          <button key={t} onClick={() => setActiveTab(t)} style={{ ...S.tab, ...(activeTab === t ? S.tabActive : {}) }}>
            {t === "all" ? "All Customers" : t === "active" ? "Active" : "Inactive"}
          </button>
        ))}
      </div>

      {/* ── TOP STAT CARDS ── */}
      <div style={S.statsRow}>
        <div style={{ ...S.card, borderTop: "3px solid #6366f1" }}>
          <div style={S.cardLabel}>Total Outstanding</div>
          <div style={{ ...S.cardVal, color: "#4338ca" }}>{fmtUSD(grandTotal)}</div>
          <div style={S.cardSub}>{custRows.length} customers</div>
        </div>
        <div style={{ ...S.card, borderTop: "3px solid #ef4444" }}>
          <div style={S.cardLabel}>Past Due</div>
          <div style={{ ...S.cardVal, color: "#dc2626" }}>{pastDueCnt}</div>
          <div style={S.cardSub}>customers with overdue</div>
        </div>
        <div style={{ ...S.card, borderTop: `3px solid ${dsoColor(aggregateDSO)}` }}>
          <div style={S.cardLabel}>Aggregate DSO</div>
          <div style={{ ...S.cardVal, color: dsoColor(aggregateDSO) }}>{aggregateDSO > 0 ? `${aggregateDSO}d` : "—"}</div>
          <div style={S.cardSub}>weighted avg · filtered set</div>
        </div>
        {BUCKETS.map(b => (
          <div key={b} style={{ ...S.card, borderTop: `3px solid ${agingColor(b)}` }}>
            <div style={S.cardLabel}>{b} days</div>
            <div style={{ ...S.cardVal, color: agingColor(b) }}>{fmtUSD(agingTot[b])}</div>
            <div style={S.cardSub}>{custRows.filter(r => bucketCount(r, b) > 0).length} customers</div>
          </div>
        ))}
      </div>

      {/* ── ACTIVE / INACTIVE QUICK FILTERS ── */}
      {activeTab !== "all" && (
        <div style={{ marginBottom: 16, display: "flex", alignItems: "center", gap: 16, background: "#fff", padding: "14px 18px", borderRadius: 10, boxShadow: "0 1px 3px rgba(0,0,0,0.05)", flexWrap: "wrap" }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: 0.6 }}>
            Filter {activeTab === "active" ? "Active" : "Inactive"} Customers:
          </span>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <label style={{ fontSize: 12, color: "#475569", fontWeight: 600, whiteSpace: "nowrap" }}>Business Type</label>
            <select style={{ ...sel, width: 160 }} value={bizF} onChange={e => setBizF(e.target.value)}>
              <option value="All">All</option>
              {bizTypeOptions.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <label style={{ fontSize: 12, color: "#475569", fontWeight: 600, whiteSpace: "nowrap" }}>Payment Mode</label>
            <select style={{ ...sel, width: 140 }} value={pmF} onChange={e => setPmF(e.target.value)}>
              <option value="All">All</option>
              <option value="auto">🤖 Auto Pay</option>
              <option value="manual">📧 Manual</option>
            </select>
          </div>
          {(bizF !== "All" || pmF !== "All") && (
            <button onClick={() => { setBizF("All"); setPmF("All"); }}
              style={{ fontSize: 12, color: "#ef4444", background: "#fee2e2", border: "1px solid #fca5a5", borderRadius: 20, padding: "5px 14px", cursor: "pointer", fontWeight: 600 }}>
              ✕ Clear filters
            </button>
          )}
        </div>
      )}

      {/* ── BUSINESS TYPE BREAKDOWN (All tab only) ── */}
      {activeTab === "all" && <div style={{ marginBottom: 20 }}>
        <div style={S.sectionLabel}>
          Business Type Breakdown
          {hasActiveFilters && <span style={{ fontWeight: 400, color: "#94a3b8", textTransform: "none", fontSize: 12, marginLeft: 6 }}>· filtered view</span>}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(250px,1fr))", gap: 12 }}>
          {bizStats.map(({ biz, total, count, dso, b0_30, b31_60, b61_90, b90_180, b180plus, autoPay, manualPay, autoPayPct }) => {
            const [fg, bg, border] = bizColor(biz);
            const pastDue = b31_60 + b61_90 + b90_180 + b180plus;
            return (
              <div key={biz} style={{ background: "#fff", borderRadius: 12, padding: "16px 18px", boxShadow: "0 1px 4px rgba(0,0,0,0.06)", border: `1px solid ${border}`, position: "relative", overflow: "hidden" }}>
                <div style={{ position: "absolute", top: 0, right: 0, width: 56, height: 56, background: bg, borderRadius: "0 12px 0 56px", opacity: 0.7 }} />
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
                  <span style={{ background: bg, color: fg, border: `1px solid ${border}`, borderRadius: 20, padding: "3px 10px", fontSize: 12, fontWeight: 700 }}>{biz}</span>
                  {dso > 0 && (
                    <span style={{ background: dsoBg(dso), color: dsoColor(dso), borderRadius: 20, padding: "3px 10px", fontSize: 12, fontWeight: 700, border: `1px solid ${dsoColor(dso)}44` }}>
                      DSO {dso}d
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 22, fontWeight: 800, color: "#0f172a", marginBottom: 2 }}>{fmtUSD(total)}</div>
                <div style={{ fontSize: 12, color: "#64748b", marginBottom: 8 }}>
                  {count} customer{count !== 1 ? "s" : ""}
                  {count > 0 && <span style={{ marginLeft: 8, color: "#6366f1" }}>🤖 {autoPayPct}% auto</span>}
                </div>
                {/* Aging mini-bar */}
                {total > 0 && (
                  <div style={{ display: "flex", height: 6, borderRadius: 4, overflow: "hidden", gap: 1, marginBottom: 8 }}>
                    {([{ v: b0_30, c: "#10b981" }, { v: b31_60, c: "#f59e0b" }, { v: b61_90, c: "#f97316" }, { v: b90_180, c: "#ef4444" }, { v: b180plus, c: "#7c3aed" }] as {v:number;c:string}[])
                      .filter(x => x.v > 0)
                      .map((x, i) => <div key={i} style={{ flex: x.v / total, background: x.c, minWidth: 3 }} />)}
                  </div>
                )}
                <div style={{ display: "flex", gap: 6, fontSize: 11, flexWrap: "wrap" }}>
                  {b0_30   > 0 && <span style={{ color: "#10b981", fontWeight: 600 }}>{fmtUSD(b0_30)}</span>}
                  {b31_60  > 0 && <span style={{ color: "#f59e0b", fontWeight: 600 }}>{fmtUSD(b31_60)}</span>}
                  {b61_90  > 0 && <span style={{ color: "#f97316", fontWeight: 600 }}>{fmtUSD(b61_90)}</span>}
                  {b90_180 > 0 && <span style={{ color: "#ef4444", fontWeight: 600 }}>{fmtUSD(b90_180)}</span>}
                  {b180plus > 0 && <span style={{ color: "#7c3aed", fontWeight: 600 }}>{fmtUSD(b180plus)}</span>}
                </div>
                {pastDue > 0 && <div style={{ marginTop: 6, fontSize: 11, color: "#ef4444", fontWeight: 600 }}>⚠ {fmtUSD(pastDue)} past due</div>}
              </div>
            );
          })}
        </div>
      </div>}

      {/* ── SEARCH + FILTER BAR ── */}
      <div style={{ marginBottom: 12, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", background: "#fff", padding: "12px 16px", borderRadius: 10, boxShadow: "0 1px 3px rgba(0,0,0,0.05)" }}>
        <input style={S.searchInput} placeholder="🔍  Search customer, domain, email..." value={search} onChange={e => setSearch(e.target.value)} />
        <span style={{ color: "#64748b", fontSize: 13, fontWeight: 500 }}>{custRows.length} customers · {fmtUSD(grandTotal)}</span>
        {aggregateDSO > 0 && (
          <span style={{ background: dsoBg(aggregateDSO), color: dsoColor(aggregateDSO), fontSize: 12, fontWeight: 700, padding: "3px 10px", borderRadius: 20, border: `1px solid ${dsoColor(aggregateDSO)}44` }}>
            DSO {aggregateDSO}d
          </span>
        )}
        {hasActiveFilters && (
          <button onClick={resetFilters} style={{ fontSize: 12, color: "#ef4444", background: "#fee2e2", border: "1px solid #fca5a5", borderRadius: 20, padding: "4px 12px", cursor: "pointer", fontWeight: 600 }}>
            ✕ Clear filters
          </button>
        )}
      </div>

      {/* ── TABLE ── */}
      <div style={S.tableWrap}>
        <table style={S.table}>
          <thead>
            <tr>
              <Th label="Domain"       col="domain" />
              <Th label="Account"      col="account" />
              <Th label="Status"       col="customer_status" />
              <Th label="Business"     col="business" />
              <Th label="CS Owner"     col="cs_email" />
              <Th label="Payment"      col="collection_method" />
              <Th label="0–30d"        col="b0_30"    color="#10b981" />
              <Th label="31–60d"       col="b31_60"   color="#f59e0b" />
              <Th label="61–90d"       col="b61_90"   color="#f97316" />
              <Th label="90–180d"      col="b90_180"  color="#ef4444" />
              <Th label="180+d"        col="b180plus" color="#7c3aed" />
              <Th label="Total (USD)"  col="total"    color="#4f46e5" />
              <Th label="DSO"          col="dso_days" color="#6366f1" />
            </tr>
            <tr style={{ background: "#f8fafc" }}>
              <FTh><input style={{ ...sel, padding: "4px 8px" }} placeholder="Domain..." value={search} onChange={e => setSearch(e.target.value)} /></FTh>
              <FTh><select style={sel} value={acctF} onChange={e => setAcctF(e.target.value)}><option value="All">All</option><option value="India">India</option><option value="US">US</option></select></FTh>
              <FTh>
                <select style={sel} value={statF} onChange={e => setStatF(e.target.value)}>
                  <option value="All">All</option>
                  {statusOptions.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </FTh>
              <FTh>
                <select style={sel} value={bizF} onChange={e => setBizF(e.target.value)}>
                  <option value="All">All</option>
                  {bizTypeOptions.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </FTh>
              <FTh>
                <select style={sel} value={csF} onChange={e => setCsF(e.target.value)}>
                  <option value="All">All</option>
                  {csEmailOptions.map(e => <option key={e} value={e}>{e}</option>)}
                </select>
              </FTh>
              <FTh>
                <select style={sel} value={pmF} onChange={e => setPmF(e.target.value)}>
                  <option value="All">All</option>
                  <option value="auto">🤖 Auto</option>
                  <option value="manual">📧 Manual</option>
                </select>
              </FTh>
              <FTh><select style={sel} value={b0_30F}    onChange={e => setB0_30F(e.target.value)}   ><option value="All">All</option><option value="Has balance">Has balance</option></select></FTh>
              <FTh><select style={sel} value={b31_60F}   onChange={e => setB31_60F(e.target.value)}  ><option value="All">All</option><option value="Has balance">Has balance</option></select></FTh>
              <FTh><select style={sel} value={b61_90F}   onChange={e => setB61_90F(e.target.value)}  ><option value="All">All</option><option value="Has balance">Has balance</option></select></FTh>
              <FTh><select style={sel} value={b90_180F}  onChange={e => setB90_180F(e.target.value)} ><option value="All">All</option><option value="Has balance">Has balance</option></select></FTh>
              <FTh><select style={sel} value={b180plusF} onChange={e => setB180plusF(e.target.value)}><option value="All">All</option><option value="Has balance">Has balance</option></select></FTh>
              <FTh>
                <select style={sel} value={totalF} onChange={e => setTotalF(e.target.value)}>
                  <option value="All">All</option>
                  <option value="<$1k">&lt;$1k</option>
                  <option value="$1k–5k">$1k–$5k</option>
                  <option value="$5k–20k">$5k–$20k</option>
                  <option value=">$20k">&gt;$20k</option>
                </select>
              </FTh>
              <FTh>
                <select style={sel} value={dsoF} onChange={e => setDsoF(e.target.value)}>
                  <option value="All">All</option>
                  <option value="0–30d">0–30d</option>
                  <option value="31–60d">31–60d</option>
                  <option value="61–90d">61–90d</option>
                  <option value=">90d">&gt;90d</option>
                </select>
              </FTh>
            </tr>
          </thead>
          <tbody>
            {custRows.length === 0
              ? <tr><td colSpan={13} style={{ textAlign: "center", padding: 48, color: "#94a3b8" }}>
                  <div style={{ fontSize: 32, marginBottom: 8 }}>🔍</div>
                  <div style={{ fontWeight: 600, marginBottom: 4 }}>No customers match your filters</div>
                  <button onClick={resetFilters} style={{ color: "#6366f1", background: "none", border: "none", cursor: "pointer", textDecoration: "underline", fontSize: 13 }}>Clear all filters</button>
                </td></tr>
              : custRows.map((r, i) => {
                  const isExp = expanded.has(r.key);
                  const invs  = (invoicesByKey.get(r.key) ?? []).sort((a, b) => b.days_overdue - a.days_overdue);
                  const [bizFg, bizBg, bizBorder] = r.business ? bizColor(r.business) : ["#6b7280", "#f3f4f6", "#e5e7eb"];
                  const rowBg = i % 2 === 0 ? "#fff" : "#fafbff";
                  return (
                    <>
                      <tr key={r.key}
                        style={{ background: rowBg, transition: "background 0.15s" }}
                        onMouseEnter={e => (e.currentTarget.style.background = "#f0f4ff")}
                        onMouseLeave={e => (e.currentTarget.style.background = rowBg)}>
                        <td style={S.td}>
                          <div style={{ fontWeight: 600, fontSize: 13, color: "#0f172a" }}>{r.domain || "--"}</div>
                          <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 1 }}>{r.customer_name}</div>
                        </td>
                        <td style={S.td}><span style={acctStyle(r.account)}>{r.account}</span></td>
                        <td style={S.td}>{r.customer_status ? <span style={statusStyle(r.customer_status)}>{r.customer_status}</span> : <span style={{ color: "#cbd5e1", fontSize: 12 }}>--</span>}</td>
                        <td style={S.td}>{r.business ? <span style={{ background: bizBg, color: bizFg, border: `1px solid ${bizBorder}`, borderRadius: 20, padding: "3px 10px", fontSize: 12, fontWeight: 700 }}>{r.business}</span> : <span style={{ color: "#cbd5e1", fontSize: 12 }}>--</span>}</td>
                        <td style={S.td}><span style={{ fontSize: 12, color: "#475569" }}>{r.cs_email?.split("@")[0] || "--"}</span></td>
                        <td style={S.td}>
                          {r.collection_method === "charge_automatically"
                            ? <span style={{ background: "#ede9fe", color: "#6366f1", borderRadius: 20, padding: "3px 10px", fontSize: 11, fontWeight: 700, border: "1px solid #c4b5fd", whiteSpace: "nowrap" }}>🤖 Auto</span>
                            : <span style={{ background: "#fef9c3", color: "#92400e", borderRadius: 20, padding: "3px 10px", fontSize: 11, fontWeight: 700, border: "1px solid #fde68a", whiteSpace: "nowrap" }}>📧 Manual</span>}
                        </td>
                        <td style={{ ...S.td, color: "#10b981", fontWeight: 700 }}>{r.b0_30   > 0 ? fmtUSD(r.b0_30)   : <span style={{ color: "#e2e8f0" }}>—</span>}</td>
                        <td style={{ ...S.td, color: "#f59e0b", fontWeight: 700 }}>{r.b31_60  > 0 ? fmtUSD(r.b31_60)  : <span style={{ color: "#e2e8f0" }}>—</span>}</td>
                        <td style={{ ...S.td, color: "#f97316", fontWeight: 700 }}>{r.b61_90  > 0 ? fmtUSD(r.b61_90)  : <span style={{ color: "#e2e8f0" }}>—</span>}</td>
                        <td style={{ ...S.td, color: "#ef4444", fontWeight: 700 }}>{r.b90_180 > 0 ? fmtUSD(r.b90_180) : <span style={{ color: "#e2e8f0" }}>—</span>}</td>
                        <td style={{ ...S.td, color: "#7c3aed", fontWeight: 700 }}>{r.b180plus > 0 ? fmtUSD(r.b180plus) : <span style={{ color: "#e2e8f0" }}>—</span>}</td>
                        <td style={{ ...S.td, fontWeight: 800, color: "#4338ca", cursor: "pointer", userSelect: "none" }} onClick={() => toggleExpand(r.key)}>
                          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            {fmtUSD(r.total)}
                            <span style={{ fontSize: 10, background: "#ede9fe", color: "#6366f1", borderRadius: 10, padding: "1px 6px", fontWeight: 700 }}>{isExp ? "▲" : "▼"} {r.invoice_count}</span>
                          </div>
                        </td>
                        <td style={S.td}>
                          {r.dso_days > 0
                            ? <span style={{ background: dsoBg(r.dso_days), color: dsoColor(r.dso_days), borderRadius: 20, padding: "3px 10px", fontSize: 12, fontWeight: 700, border: `1px solid ${dsoColor(r.dso_days)}44`, whiteSpace: "nowrap" }}>{r.dso_days}d</span>
                            : <span style={{ color: "#cbd5e1", fontSize: 12 }}>--</span>}
                        </td>
                      </tr>
                      {isExp && invs.map(inv => (
                        <tr key={inv.id} style={{ background: "#f5f3ff", borderLeft: "3px solid #818cf8" }}>
                          <td style={{ ...S.td, paddingLeft: 20, fontSize: 12 }} colSpan={2}>
                            <span style={{ fontFamily: "monospace", color: "#6366f1", fontWeight: 700 }}>{inv.invoice_number}</span>
                            {inv.description && <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 2 }}>{inv.description.slice(0, 60)}</div>}
                          </td>
                          <td style={{ ...S.td, fontSize: 12, color: "#475569" }}>{inv.due_date ?? "No due date"}</td>
                          <td style={{ ...S.td, fontSize: 12, color: inv.days_overdue > 0 ? "#ef4444" : "#10b981", fontWeight: 700 }}>
                            {inv.days_overdue > 0 ? `${inv.days_overdue}d overdue` : "Not due"}
                          </td>
                          <td style={S.td}>
                            <span style={{ background: agingColor(inv.aging_bucket) + "22", color: agingColor(inv.aging_bucket), border: `1px solid ${agingColor(inv.aging_bucket)}55`, borderRadius: 20, padding: "2px 8px", fontSize: 11, fontWeight: 700 }}>
                              {inv.aging_bucket}
                            </span>
                          </td>
                          <td style={{ ...S.td, fontWeight: 700, fontSize: 13, color: "#4338ca" }} colSpan={8}>
                            {fmtUSD(inv.amount_usd)}
                            {inv.currency !== "USD" && <span style={{ fontSize: 11, color: "#94a3b8", marginLeft: 6 }}>{inv.currency} {inv.amount_due.toLocaleString()}</span>}
                            {inv.invoice_url && <a href={inv.invoice_url} target="_blank" rel="noreferrer" style={{ marginLeft: 12, color: "#6366f1", fontSize: 12, fontWeight: 600 }}>View ↗</a>}
                          </td>
                        </tr>
                      ))}
                    </>
                  );
                })}
          </tbody>
          {custRows.length > 0 && (
            <tfoot>
              <tr style={{ background: "#f1f5f9", fontWeight: 800 }}>
                <td style={{ ...S.td, fontWeight: 800, color: "#0f172a" }} colSpan={5}>
                  Subtotal — {custRows.length} customers
                  {aggregateDSO > 0 && (
                    <span style={{ marginLeft: 10, background: dsoBg(aggregateDSO), color: dsoColor(aggregateDSO), borderRadius: 20, padding: "2px 10px", fontSize: 12, fontWeight: 700, border: `1px solid ${dsoColor(aggregateDSO)}44` }}>
                      DSO {aggregateDSO}d
                    </span>
                  )}
                </td>
                <td style={{ ...S.td, color: "#10b981", fontWeight: 800 }}>{fmtUSD(agingTot["0-30"])}</td>
                <td style={{ ...S.td, color: "#f59e0b", fontWeight: 800 }}>{fmtUSD(agingTot["31-60"])}</td>
                <td style={{ ...S.td, color: "#f97316", fontWeight: 800 }}>{fmtUSD(agingTot["61-90"])}</td>
                <td style={{ ...S.td, color: "#ef4444", fontWeight: 800 }}>{fmtUSD(agingTot["90-180"])}</td>
                <td style={{ ...S.td, color: "#7c3aed", fontWeight: 800 }}>{fmtUSD(agingTot["180+"])}</td>
                <td style={{ ...S.td, color: "#4338ca", fontWeight: 800, fontSize: 16 }}>{fmtUSD(grandTotal)}</td>
                <td style={S.td} />
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      <div style={{ textAlign: "center", padding: "16px 0", color: "#94a3b8", fontSize: 12 }}>
        Click ⟳ for live data · Click Total to expand invoices · DSO = weighted average age of open invoices
      </div>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  page:        { maxWidth: 1700, margin: "0 auto", padding: "24px 20px", background: "#f1f5f9", minHeight: "100vh" },
  header:      { display: "flex", alignItems: "center", justifyContent: "space-between", background: "linear-gradient(135deg,#0f172a 0%,#1e1b4b 55%,#312e81 100%)", borderRadius: 14, padding: "22px 28px", marginBottom: 20, flexWrap: "wrap", gap: 12, boxShadow: "0 4px 24px rgba(99,102,241,0.22)" },
  ghostBtn:    { background: "rgba(255,255,255,0.1)", color: "#e2e8f0", border: "1px solid rgba(255,255,255,0.2)", borderRadius: 8, padding: "9px 16px", fontWeight: 600, fontSize: 13, cursor: "pointer" },
  exportBtn:   { background: "linear-gradient(135deg,#6366f1,#4338ca)", color: "#fff", border: "none", borderRadius: 8, padding: "9px 20px", fontWeight: 700, fontSize: 13, cursor: "pointer", boxShadow: "0 2px 10px rgba(99,102,241,0.45)" },
  toast:       { background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 10, padding: "12px 18px", marginBottom: 16, fontSize: 13, color: "#166534", fontWeight: 600 },
  tabBar:      { display: "flex", gap: 4, marginBottom: 18, background: "#fff", padding: "6px", borderRadius: 10, boxShadow: "0 1px 3px rgba(0,0,0,0.05)", width: "fit-content" },
  tab:         { background: "none", border: "none", borderRadius: 8, padding: "8px 20px", fontWeight: 600, fontSize: 13, cursor: "pointer", color: "#64748b", transition: "all 0.15s" },
  tabActive:   { background: "linear-gradient(135deg,#6366f1,#4338ca)", color: "#fff", boxShadow: "0 2px 8px rgba(99,102,241,0.3)" },
  statsRow:    { display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(185px,1fr))", gap: 12, marginBottom: 20 },
  card:        { background: "#fff", borderRadius: 12, padding: "18px 20px", boxShadow: "0 1px 4px rgba(0,0,0,0.06)" },
  cardLabel:   { fontSize: 11, color: "#64748b", marginBottom: 4, fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: 0.6 },
  cardVal:     { fontSize: 24, fontWeight: 800, marginBottom: 2 },
  cardSub:     { fontSize: 12, color: "#94a3b8" },
  sectionLabel:{ fontSize: 11, fontWeight: 700, color: "#64748b", marginBottom: 10, letterSpacing: 0.8, textTransform: "uppercase" as const },
  searchInput: { border: "1px solid #e2e8f0", borderRadius: 8, padding: "9px 14px", fontSize: 14, width: 320, outline: "none", background: "#fff" },
  tableWrap:   { background: "#fff", borderRadius: 12, boxShadow: "0 1px 4px rgba(0,0,0,0.06)", overflow: "auto", marginBottom: 20 },
  table:       { width: "100%", borderCollapse: "collapse", fontSize: 14 },
  th:          { textAlign: "left", padding: "13px 14px", fontWeight: 700, fontSize: 11, borderBottom: "2px solid #e2e8f0", whiteSpace: "nowrap", background: "#f8fafc", textTransform: "uppercase" as const, letterSpacing: 0.5 },
  td:          { padding: "11px 14px", borderBottom: "1px solid #f1f5f9", verticalAlign: "middle" },
  center:      { display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100vh", gap: 8, background: "#f1f5f9" },
  spin:        { width: 40, height: 40, border: "4px solid #e2e8f0", borderTop: "4px solid #6366f1", borderRadius: "50%", animation: "spin 0.8s linear infinite" },
};
