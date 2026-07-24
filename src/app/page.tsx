"use client";
import { useEffect, useState, useMemo, useCallback } from "react";
import * as XLSX from "xlsx";
import type { InvoiceRow, AgingBucket, AllCustomer, AllCustomerInvoice } from "@/lib/stripe";

// ── Plan-change (upgrade/downgrade) API types ─────────────────────────────────
interface PlanChangeRow {
  detected_at: string;
  customer_id: string;
  account: string;
  customer_name: string;
  domain: string;
  business: string;
  cs_email: string;
  change_type: string; // "Upgrade" | "Downgrade" | "Currency Switch" | "Plan Changed"
  previous_value: number;
  new_value: number;
  previous_currency: string;
  new_currency: string;
  previous_plan: string;
  new_plan: string;
}
interface PlanCurrentRow {
  customer_id: string;
  account: string;
  customer_name: string;
  domain: string;
  business: string;
  cs_email: string;
  currency: string;
  plan_value: number;
  plan_summary: string;
  status: string; // "Baseline" | "No Change" | "Upgrade" | "Downgrade" | "Currency Switch" | "Plan Changed"
}
interface PlanChangesApiResponse {
  changes: PlanChangeRow[];
  current?: PlanCurrentRow[];
  asOf: string;
  newly_detected?: number;
  subscriptions_found?: number;
}

// ── API interfaces ─────────────────────────────────────────────────────────────
interface InvoiceRowWithUsd extends InvoiceRow { amount_usd: number; }
interface CustomerDSOWithUsd {
  customer_id: string;
  customer_name: string;
  customer_email: string;
  domain: string;
  business: string;
  cs_email: string;
  customer_status: string;
  account: "India" | "US";
  currency: string;
  total_outstanding: number;
  total_outstanding_usd: number;
  total_outstanding_ex_tax: number;
  latest_invoice_amt_ex_tax: number;
  total_sales_12m_usd: number;
  sales_3m_usd: number;
  dso_days: number;
  invoice_count: number;
  collection_method: "charge_automatically" | "send_invoice";
}
interface ApiResponse {
  invoices: InvoiceRowWithUsd[];
  dso: CustomerDSOWithUsd[];
  inrPerUsd: number;
}
interface AllCustomersApiResponse {
  customers: AllCustomer[];
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
  total_outstanding_ex_tax: number;
  latest_invoice_amt_ex_tax: number;
  collection_method: "charge_automatically" | "send_invoice";
  sales_3m_usd: number;
}

// ── Formatting / colour helpers ───────────────────────────────────────────────
const fmtUSD = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);

const fmtDate = (d: string | null | undefined) => {
  if (!d) return "—";
  const [y, m, day] = d.split("-");
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${months[parseInt(m) - 1]} ${parseInt(day)}, ${y}`;
};

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

function invoiceStatusStyle(s: string): React.CSSProperties {
  const base: React.CSSProperties = { borderRadius: 20, padding: "2px 9px", fontSize: 11, fontWeight: 700, display: "inline-block" };
  if (s === "paid")          return { ...base, color: "#065f46", background: "#d1fae5", border: "1px solid #6ee7b7" };
  if (s === "open")          return { ...base, color: "#92400e", background: "#fef3c7", border: "1px solid #fcd34d" };
  if (s === "void")          return { ...base, color: "#64748b", background: "#f1f5f9", border: "1px solid #cbd5e1" };
  if (s === "uncollectible") return { ...base, color: "#7f1d1d", background: "#fee2e2", border: "1px solid #fca5a5" };
  return { ...base, color: "#374151", background: "#f3f4f6", border: "1px solid #d1d5db" };
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
  const [activeTab, setActiveTab]     = useState<"all" | "active" | "inactive" | "autopay" | "manual" | "ledger" | "planChanges">("all");
  const [pmTabExpanded, setPmTabExpanded] = useState(false);

  /** "due_date" = use effective due date (autopay falls back to invoice date).
   *  "invoice_date" = always age from invoice creation date. */
  const [agingMode, setAgingMode] = useState<"due_date" | "invoice_date">("due_date");

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
  const [pmF,       setPmF]       = useState("All");

  // ── Ledger tab state ──────────────────────────────────────────────────────
  const [ledgerData, setLedgerData]       = useState<AllCustomersApiResponse | null>(null);
  const [ledgerLoading, setLedgerLoading] = useState(false);
  const [ledgerError, setLedgerError]     = useState<string | null>(null);
  const [ledgerExpanded, setLedgerExpanded] = useState<Set<string>>(new Set());
  const [ledgerSearch, setLedgerSearch]   = useState("");
  const [ledgerAcctF, setLedgerAcctF]     = useState("All");
  const [ledgerStatF, setLedgerStatF]     = useState("All");
  const [ledgerBizF,  setLedgerBizF]      = useState("All");
  const [ledgerSortCol, setLedgerSortCol] = useState<"latest_invoice_date" | "first_invoice_date" | "customer_name" | "domain">("latest_invoice_date");
  const [ledgerSortDir, setLedgerSortDir] = useState<"asc" | "desc">("desc");

  // ── Plan changes (upgrade/downgrade) tab state ────────────────────────────
  const [planData, setPlanData]       = useState<PlanChangesApiResponse | null>(null);
  const [planLoading, setPlanLoading] = useState(false);
  const [planError, setPlanError]     = useState<string | null>(null);
  const [planSearch, setPlanSearch]   = useState("");
  const [planTypeF, setPlanTypeF]     = useState<"All" | "Upgrade" | "Downgrade" | "Currency Switch" | "Plan Changed">("All");
  const [planAcctF, setPlanAcctF]     = useState("All");
  /** Set of "YYYY-MM" strings. Empty set = no month filter (show all months). */
  const [planMonthsF, setPlanMonthsF] = useState<Set<string>>(new Set());
  const [planMonthPickerOpen, setPlanMonthPickerOpen] = useState(false);

  // ── Plan Changes: view mode + revenue month-over-month state ──────────────
  const [planViewMode, setPlanViewMode] = useState<"tier" | "revenue">("tier");
  /** Months selected as columns for the revenue view — NOT empty-means-all like planMonthsF; defaults to the 2 most recent months once data loads. */
  const [revenueMonthsF, setRevenueMonthsF] = useState<Set<string>>(new Set());
  const [revenueMonthPickerOpen, setRevenueMonthPickerOpen] = useState(false);

  // ── Data loading ─────────────────────────────────────────────────────────
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

  const loadLedger = useCallback((bust = false) => {
    setLedgerLoading(true);
    setLedgerError(null);
    fetch(bust ? "/api/all-customers?bust=1" : "/api/all-customers")
      .then(r => r.json())
      .then(d => {
        if (d.error) throw new Error(d.error);
        setLedgerData(d);
      })
      .catch(e => setLedgerError(e.message))
      .finally(() => setLedgerLoading(false));
  }, []);

  const loadPlanChanges = useCallback(() => {
    setPlanLoading(true);
    setPlanError(null);
    fetch("/api/plan-changes")
      .then(r => r.json())
      .then(d => {
        if (d.error) throw new Error(d.error);
        setPlanData(d);
      })
      .catch(e => setPlanError(e.message))
      .finally(() => setPlanLoading(false));
  }, []);

  useEffect(() => { loadData(false); }, [loadData]);

  // Lazy-load ledger when the tab is first opened
  useEffect(() => {
    if (activeTab === "ledger" && !ledgerData && !ledgerLoading) {
      loadLedger();
    }
  }, [activeTab, ledgerData, ledgerLoading, loadLedger]);

  // Lazy-load plan changes when the tab is first opened
  useEffect(() => {
    if (activeTab === "planChanges" && !planData && !planLoading) {
      loadPlanChanges();
    }
  }, [activeTab, planData, planLoading, loadPlanChanges]);

  // Lazy-load ledger data (reused as the source for the revenue month-over-month view)
  useEffect(() => {
    if (activeTab === "planChanges" && planViewMode === "revenue" && !ledgerData && !ledgerLoading) {
      loadLedger();
    }
  }, [activeTab, planViewMode, ledgerData, ledgerLoading, loadLedger]);

  const allInvoices = useMemo(() => data?.invoices ?? [], [data]);

  const autoPayStats = useMemo(() => {
    const allDso  = data?.dso ?? [];
    const autoPay = allDso.filter(d => d.collection_method === "charge_automatically").length;
    const total   = allDso.length;
    return { total, autoPay, manual: total - autoPay, autoPayPct: total > 0 ? Math.round(autoPay / total * 100) : 0 };
  }, [data]);

  const dsoDataMap = useMemo(() => {
    const m = new Map<string, CustomerDSOWithUsd>();
    for (const d of data?.dso ?? []) m.set(`${d.account}::${d.customer_id}`, d);
    return m;
  }, [data]);

  // ── Aging-mode-aware bucket helper ────────────────────────────────────────
  const getBucket = useCallback((inv: InvoiceRowWithUsd) =>
    agingMode === "invoice_date" ? inv.aging_bucket_from_invoice : inv.aging_bucket,
  [agingMode]);

  // Aging bucket totals per customer from open invoices (for payModeCustRows)
  const openInvoiceMap = useMemo(() => {
    const m = new Map<string, { b0_30: number; b31_60: number; b61_90: number; b90_180: number; b180plus: number; total: number; invoice_count: number }>();
    for (const inv of allInvoices) {
      const key = `${inv.account}::${inv.customer_id}`;
      if (!m.has(key)) m.set(key, { b0_30: 0, b31_60: 0, b61_90: 0, b90_180: 0, b180plus: 0, total: 0, invoice_count: 0 });
      const r = m.get(key)!;
      r.total += inv.amount_usd; r.invoice_count++;
      const b = getBucket(inv);
      if      (b === "0-30")   r.b0_30   += inv.amount_usd;
      else if (b === "31-60")  r.b31_60  += inv.amount_usd;
      else if (b === "61-90")  r.b61_90  += inv.amount_usd;
      else if (b === "90-180") r.b90_180 += inv.amount_usd;
      else                     r.b180plus += inv.amount_usd;
    }
    return m;
  }, [allInvoices, getBucket]);

  // ── Cascading filter options ──────────────────────────────────────────────
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

  // ── Customer rows ─────────────────────────────────────────────────────────
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
      if (activeTab === "active"   && inv.customer_status !== "Active")              continue;
      if (activeTab === "inactive" && inv.customer_status === "Active")              continue;
      if (activeTab === "autopay"  && inv.collection_method !== "charge_automatically") continue;
      if (activeTab === "manual"   && inv.collection_method !== "send_invoice")      continue;
      if (activeTab !== "autopay" && activeTab !== "manual") {
        if (pmF === "auto"   && inv.collection_method !== "charge_automatically") continue;
        if (pmF === "manual" && inv.collection_method !== "send_invoice")         continue;
      }

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
          total_outstanding_ex_tax: dsoData?.total_outstanding_ex_tax ?? 0,
          latest_invoice_amt_ex_tax: dsoData?.latest_invoice_amt_ex_tax ?? 0,
          collection_method: dsoData?.collection_method ?? inv.collection_method,
          sales_3m_usd: dsoData?.sales_3m_usd ?? 0,
        });
      }
      const r = map.get(key)!;
      r.total += inv.amount_usd;
      r.invoice_count++;
      // Use the selected aging mode to assign the bucket
      const b = getBucket(inv);
      if      (b === "0-30")   r.b0_30   += inv.amount_usd;
      else if (b === "31-60")  r.b31_60  += inv.amount_usd;
      else if (b === "61-90")  r.b61_90  += inv.amount_usd;
      else if (b === "90-180") r.b90_180 += inv.amount_usd;
      else                     r.b180plus += inv.amount_usd;
    }

    return Array.from(map.values())
      .map(r => {
        const d = dsoDataMap.get(r.key);
        return {
          ...r,
          dso_days: d?.dso_days ?? 0,
          total_outstanding_ex_tax: d?.total_outstanding_ex_tax ?? r.total_outstanding_ex_tax,
          latest_invoice_amt_ex_tax: d?.latest_invoice_amt_ex_tax ?? r.latest_invoice_amt_ex_tax,
        };
      })
      .filter(r => {
        if (b0_30F    === "Has balance" && r.b0_30    <= 0) return false;
        if (b31_60F   === "Has balance" && r.b31_60   <= 0) return false;
        if (b61_90F   === "Has balance" && r.b61_90   <= 0) return false;
        if (b90_180F  === "Has balance" && r.b90_180  <= 0) return false;
        if (b180plusF === "Has balance" && r.b180plus <= 0) return false;
        if (dsoF === "<30d"    && !(r.dso_days > 0 && r.dso_days < 30))     return false;
        if (dsoF === ">30d"    && !(r.dso_days > 30))                        return false;
        if (dsoF === "0–30d"   && !(r.dso_days <= 30))                       return false;
        if (dsoF === "31–60d"  && !(r.dso_days > 30 && r.dso_days <= 60))   return false;
        if (dsoF === "61–90d"  && !(r.dso_days > 60 && r.dso_days <= 90))   return false;
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
      b0_30F, b31_60F, b61_90F, b90_180F, b180plusF, dsoF, totalF, sortCol, sortDir,
      getBucket]);

  // ── Auto Pay / Manual full customer list ──────────────────────────────────
  const payModeCustRows = useMemo((): CustRow[] => {
    if (activeTab !== "autopay" && activeTab !== "manual") return [];
    const targetCm = activeTab === "autopay" ? "charge_automatically" : "send_invoice";
    return (data?.dso ?? [])
      .filter(d => d.collection_method === targetCm)
      .filter(d => bizF  === "All" || d.business === bizF)
      .filter(d => acctF === "All" || d.account  === acctF)
      .filter(d => statF === "All" || d.customer_status === statF)
      .filter(d => csF   === "All" || d.cs_email  === csF)
      .filter(d => {
        if (!search) return true;
        const q = search.toLowerCase();
        return [d.customer_name, d.customer_email, d.domain, d.business, d.cs_email]
          .some(v => v?.toLowerCase().includes(q));
      })
      .map(d => {
        const key  = `${d.account}::${d.customer_id}`;
        const open = openInvoiceMap.get(key) ?? { b0_30: 0, b31_60: 0, b61_90: 0, b90_180: 0, b180plus: 0, total: 0, invoice_count: 0 };
        return {
          key,
          customer_name:    d.customer_name,
          customer_email:   d.customer_email,
          domain:           d.domain,
          customer_status:  d.customer_status,
          business:         d.business,
          cs_email:         d.cs_email,
          account:          d.account,
          b0_30:     open.b0_30,
          b31_60:    open.b31_60,
          b61_90:    open.b61_90,
          b90_180:   open.b90_180,
          b180plus:  open.b180plus,
          total:         open.total,
          invoice_count: open.invoice_count,
          dso_days:      d.dso_days,
          total_outstanding_ex_tax:  d.total_outstanding_ex_tax  ?? 0,
          latest_invoice_amt_ex_tax: d.latest_invoice_amt_ex_tax ?? 0,
          collection_method: d.collection_method,
          sales_3m_usd:  d.sales_3m_usd,
        };
      })
      .sort((a, b) => {
        const av = a[sortCol], bv = b[sortCol];
        const cmp = typeof av === "number" && typeof bv === "number"
          ? av - bv : String(av ?? "").localeCompare(String(bv ?? ""));
        return sortDir === "asc" ? cmp : -cmp;
      });
  }, [activeTab, data, bizF, acctF, statF, csF, search, openInvoiceMap, sortCol, sortDir]);

  const displayRows = (activeTab === "autopay" || activeTab === "manual") ? payModeCustRows : custRows;

  const invoicesByKey = useMemo(() => {
    const m = new Map<string, InvoiceRowWithUsd[]>();
    for (const inv of allInvoices) {
      const k = `${inv.account}::${inv.customer_id}`;
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(inv);
    }
    return m;
  }, [allInvoices]);

  // ── Derived stats ─────────────────────────────────────────────────────────
  const grandTotal   = useMemo(() => displayRows.reduce((s, r) => s + r.total, 0), [displayRows]);
  const pastDueCnt   = useMemo(() => displayRows.filter(r => r.b31_60 + r.b61_90 + r.b90_180 + r.b180plus > 0).length, [displayRows]);
  const agingTot     = useMemo(() => {
    const m: Record<AgingBucket, number> = { "0-30": 0, "31-60": 0, "61-90": 0, "90-180": 0, "180+": 0 };
    displayRows.forEach(r => { m["0-30"] += r.b0_30; m["31-60"] += r.b31_60; m["61-90"] += r.b61_90; m["90-180"] += r.b90_180; m["180+"] += r.b180plus; });
    return m;
  }, [displayRows]);

  const aggregateDSO = useMemo(() => {
    // Same formula as per-customer DSO: Σ outstanding_ex_tax / (Σ latest_invoice_ex_tax / 30)
    const withDso = displayRows.filter(r => r.dso_days > 0);
    const totalExTax   = withDso.reduce((s, r) => s + r.total_outstanding_ex_tax,  0);
    const totalLastInv = withDso.reduce((s, r) => s + r.latest_invoice_amt_ex_tax, 0);
    const dailyMrr = totalLastInv / 30;
    return totalExTax > 0 && dailyMrr > 0 ? Math.round(totalExTax / dailyMrr) : 0;
  }, [displayRows]);

  const bizStats = useMemo(() => {
    const map = new Map<string, {
      total: number; count: number;
      totalExTax: number; totalLastInv: number;
      b0_30: number; b31_60: number; b61_90: number; b90_180: number; b180plus: number;
      autoPay: number; manualPay: number; sales_3m: number;
    }>();
    for (const r of displayRows) {
      const biz = r.business || "Other";
      if (!map.has(biz)) map.set(biz, { total: 0, count: 0, totalExTax: 0, totalLastInv: 0, b0_30: 0, b31_60: 0, b61_90: 0, b90_180: 0, b180plus: 0, autoPay: 0, manualPay: 0, sales_3m: 0 });
      const b = map.get(biz)!;
      b.total += r.total; b.count++;
      if (r.dso_days > 0) {
        b.totalExTax   += r.total_outstanding_ex_tax;
        b.totalLastInv += r.latest_invoice_amt_ex_tax;
      }
      b.b0_30 += r.b0_30; b.b31_60 += r.b31_60; b.b61_90 += r.b61_90; b.b90_180 += r.b90_180; b.b180plus += r.b180plus;
      if (r.collection_method === "charge_automatically") b.autoPay++; else b.manualPay++;
      b.sales_3m += r.sales_3m_usd;
    }
    return Array.from(map.entries()).map(([biz, v]) => ({
      biz,
      total: v.total, count: v.count,
      dso: v.totalLastInv > 0 ? Math.round(v.totalExTax / (v.totalLastInv / 30)) : 0,
      b0_30: v.b0_30, b31_60: v.b31_60, b61_90: v.b61_90, b90_180: v.b90_180, b180plus: v.b180plus,
      autoPay: v.autoPay, manualPay: v.manualPay,
      autoPayPct: v.count > 0 ? Math.round(v.autoPay / v.count * 100) : 0,
      manualPayPct: v.count > 0 ? Math.round(v.manualPay / v.count * 100) : 0,
      sales_3m: v.sales_3m,
    })).sort((a, b) => b.total - a.total);
  }, [displayRows]);

  // ── Ledger filtered rows ──────────────────────────────────────────────────
  const ledgerRows = useMemo(() => {
    const customers = ledgerData?.customers ?? [];
    return customers
      .filter(c => ledgerAcctF === "All" || c.account === ledgerAcctF)
      .filter(c => ledgerStatF === "All" || c.customer_status === ledgerStatF)
      .filter(c => ledgerBizF  === "All" || c.business === ledgerBizF)
      .filter(c => {
        if (!ledgerSearch) return true;
        const q = ledgerSearch.toLowerCase();
        return [c.domain, c.customer_name, c.customer_email, c.business, c.cs_email]
          .some(v => v?.toLowerCase().includes(q));
      })
      .sort((a, b) => {
        const av = a[ledgerSortCol] ?? "";
        const bv = b[ledgerSortCol] ?? "";
        const cmp = String(av).localeCompare(String(bv));
        return ledgerSortDir === "asc" ? cmp : -cmp;
      });
  }, [ledgerData, ledgerAcctF, ledgerStatF, ledgerBizF, ledgerSearch, ledgerSortCol, ledgerSortDir]);

  const ledgerBizOptions = useMemo(() =>
    Array.from(new Set((ledgerData?.customers ?? []).map(c => c.business).filter(Boolean))).sort(),
  [ledgerData]);

  const ledgerStatOptions = useMemo(() =>
    Array.from(new Set((ledgerData?.customers ?? []).map(c => c.customer_status).filter(Boolean))).sort(),
  [ledgerData]);

  // ── Plan changes filtered rows ────────────────────────────────────────────
  const planMonthOptions = useMemo(() => {
    const months = new Set<string>();
    for (const c of planData?.changes ?? []) {
      const ym = c.detected_at?.slice(0, 7); // "YYYY-MM"
      if (ym) months.add(ym);
    }
    return Array.from(months).sort().reverse();
  }, [planData]);

  const planMonthLabel = (ym: string) => {
    const [y, m] = ym.split("-");
    const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    return `${months[parseInt(m) - 1]} ${y}`;
  };

  function togglePlanMonth(ym: string) {
    setPlanMonthsF(prev => {
      const n = new Set(prev);
      n.has(ym) ? n.delete(ym) : n.add(ym);
      return n;
    });
  }

  const planRows = useMemo(() => {
    const changes = planData?.changes ?? [];
    return changes
      .filter(c => planAcctF === "All" || c.account === planAcctF)
      .filter(c => planTypeF === "All" || c.change_type === planTypeF)
      .filter(c => planMonthsF.size === 0 || planMonthsF.has(c.detected_at?.slice(0, 7)))
      .filter(c => {
        if (!planSearch) return true;
        const q = planSearch.toLowerCase();
        return [c.customer_name, c.domain, c.business, c.cs_email]
          .some(v => v?.toLowerCase().includes(q));
      });
  }, [planData, planAcctF, planTypeF, planMonthsF, planSearch]);

  const planCountBase = useMemo(() => {
    const changes = planData?.changes ?? [];
    return changes
      .filter(c => planAcctF === "All" || c.account === planAcctF)
      .filter(c => planMonthsF.size === 0 || planMonthsF.has(c.detected_at?.slice(0, 7)));
  }, [planData, planAcctF, planMonthsF]);
  const planUpgradeCount   = useMemo(() => planCountBase.filter(c => c.change_type === "Upgrade").length, [planCountBase]);
  const planDowngradeCount = useMemo(() => planCountBase.filter(c => c.change_type === "Downgrade").length, [planCountBase]);

  // ── Current subscription snapshot (so the tab isn't empty before a 2nd check exists) ──
  const planCurrentRows = useMemo(() => {
    const rows = planData?.current ?? [];
    return rows
      .filter(c => planAcctF === "All" || c.account === planAcctF)
      .filter(c => {
        if (!planSearch) return true;
        const q = planSearch.toLowerCase();
        return [c.customer_name, c.domain, c.business, c.cs_email].some(v => v?.toLowerCase().includes(q));
      })
      .sort((a, b) => (a.domain || a.customer_name).localeCompare(b.domain || b.customer_name));
  }, [planData, planAcctF, planSearch]);

  // ── Revenue month-over-month (invoiced amount, native currency, per calendar month) ──
  // NOTE: this is ex-GST, ex-credit-note revenue, specifically for MRR/upsell/downgrade/churn tracking.
  // The Outstanding Invoices / DSO / All Customers Data tabs elsewhere stay as-is on purpose.
  const INDIA_GST_RATE = 0.18;
  /** Revenue actually recognized for one invoice: nets out any Credit Notes first (a fully-credited
   *  invoice = no sale, contributes 0), then strips GST for India (Stripe's own tax figure when available,
   *  proportionally scaled down if the invoice was partially credited; otherwise assumes 18% is baked in). */
  function recognizedRevenue(inv: AllCustomerInvoice, account: "India" | "US"): number {
    const netGross = Math.max(0, inv.amount - (inv.credited ?? 0)); // credit note reduces/zeroes the sale
    if (account !== "India") return netGross;
    if (netGross === 0) return 0;
    if (inv.tax && inv.tax > 0) {
      // Scale the known tax figure down by the same proportion that was credited, so a partial
      // credit note doesn't leave a disproportionate amount of tax behind.
      const creditRatio = inv.amount > 0 ? netGross / inv.amount : 1;
      return netGross - inv.tax * creditRatio;
    }
    return netGross / (1 + INDIA_GST_RATE);
  }

  interface RevenueInvoiceRef {
    invoice_number: string; invoice_date: string; paid_at: string | null; amount: number; status: string;
  }
  interface RevenueMonthCell {
    amount: number; currency: string; invoices: RevenueInvoiceRef[];
    /** product_key -> { name, total amount for this month }, aggregated across all invoices booked to this month.
     *  Raw Stripe line amounts (not GST/credit-note adjusted) — used only to explain WHY the total moved. */
    products: Map<string, { name: string; amount: number }>;
  }
  interface RevenueCustomerEntry {
    domain: string; customer_name: string; business: string; cs_email: string;
    account: "India" | "US"; customer_status: string;
    monthly: Map<string, RevenueMonthCell>; // "YYYY-MM" -> total revenue booked to that month (full invoice amount, ex-GST/ex-credit-note for India)
    /** Every invoice's [period_start, period_end) as real Date ranges — used only to tell whether a
     *  zero-revenue month is still "covered" by an earlier multi-month invoice (so it doesn't falsely
     *  read as Churned), NOT to split dollars across months. */
    coverage: { start: number; end: number }[];
  }
  const revenueByCustomer = useMemo(() => {
    const map = new Map<string, RevenueCustomerEntry>();
    for (const cust of ledgerData?.customers ?? []) {
      const key = `${cust.account}::${cust.customer_id}`;
      if (!map.has(key)) {
        map.set(key, {
          domain: cust.domain, customer_name: cust.customer_name, business: cust.business,
          cs_email: cust.cs_email, account: cust.account, customer_status: cust.customer_status,
          monthly: new Map(), coverage: [],
        });
      }
      const entry = map.get(key)!;
      for (const inv of cust.invoices) {
        if (inv.status === "void") continue; // voided invoices aren't real revenue
        const amount = recognizedRevenue(inv, cust.account);
        // Bucket the FULL amount into the period's start month (falls back to invoice_date) — a
        // Jun 23–Jul 23 period is simply June revenue, no day-by-day splitting.
        const ym = (inv.period_start ?? inv.invoice_date).slice(0, 7);
        const invRef: RevenueInvoiceRef = { invoice_number: inv.invoice_number, invoice_date: inv.invoice_date, paid_at: inv.paid_at, amount, status: inv.status };
        if (!entry.monthly.has(ym)) entry.monthly.set(ym, { amount: 0, currency: inv.currency, invoices: [], products: new Map() });
        const cell = entry.monthly.get(ym)!;
        cell.amount += amount;
        cell.currency = inv.currency;
        cell.invoices.push(invRef);
        for (const line of inv.line_items) {
          const p = cell.products.get(line.product_key);
          if (p) p.amount += line.amount;
          else cell.products.set(line.product_key, { name: line.name, amount: line.amount });
        }
        // Track coverage separately from the dollar bucketing — this is what lets a multi-month
        // period (e.g. Jan–Jul) keep the intervening months from looking like Churn, without
        // touching how the revenue dollars themselves are counted.
        if (inv.period_start && inv.period_end) {
          const s = new Date(`${inv.period_start}T00:00:00Z`).getTime();
          const e = new Date(`${inv.period_end}T00:00:00Z`).getTime();
          if (e > s) entry.coverage.push({ start: s, end: e });
        }
      }
    }
    return map;
  }, [ledgerData]);

  /** True if `ym` ("YYYY-MM") falls inside any invoice's [period_start, period_end) range for this customer. */
  function isCoveredInMonth(coverage: { start: number; end: number }[], ym: string): boolean {
    const [y, m] = ym.split("-").map(Number);
    const monthStart = Date.UTC(y, m - 1, 1);
    const monthEnd = Date.UTC(y, m, 1); // exclusive
    return coverage.some(c => c.start < monthEnd && c.end > monthStart);
  }

  /** Compares two months' product-level totals for one customer and explains WHY the total moved:
   *  new products added, products that dropped off, and existing products whose amount changed. */
  interface RevenueReason { type: "New Product" | "Product Removed" | "Price Increase" | "Price Decrease"; name: string; delta: number; from: number; to: number; }
  function diffProducts(
    curProducts: Map<string, { name: string; amount: number }> | undefined,
    prevProducts: Map<string, { name: string; amount: number }> | undefined
  ): RevenueReason[] {
    const cur = curProducts ?? new Map();
    const prev = prevProducts ?? new Map();
    const reasons: RevenueReason[] = [];
    for (const [key, c] of cur.entries()) {
      const p = prev.get(key);
      if (!p) {
        if (c.amount > 0.01) reasons.push({ type: "New Product", name: c.name, delta: c.amount, from: 0, to: c.amount });
      } else if (Math.abs(c.amount - p.amount) > 0.01) {
        reasons.push({ type: c.amount > p.amount ? "Price Increase" : "Price Decrease", name: c.name, delta: c.amount - p.amount, from: p.amount, to: c.amount });
      }
    }
    for (const [key, p] of prev.entries()) {
      if (!cur.has(key) && p.amount > 0.01) {
        reasons.push({ type: "Product Removed", name: p.name, delta: -p.amount, from: p.amount, to: 0 });
      }
    }
    // Biggest dollar impact first
    reasons.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
    return reasons;
  }

  const revenueMonthOptions = useMemo(() => {
    const months = new Set<string>();
    for (const entry of revenueByCustomer.values()) {
      for (const ym of entry.monthly.keys()) months.add(ym);
    }
    return Array.from(months).sort().reverse(); // newest first
  }, [revenueByCustomer]);

  /** The 2 most recent months to default to — excludes anything after the real current month, so a single
   *  invoice with a mistaken far-future period_end can't hijack "recent" and make the view default to
   *  a near-empty future month. Falls back to the raw newest 2 only if literally everything is in the future. */
  const sensibleDefaultMonths = useMemo(() => {
    const nowYm = new Date().toISOString().slice(0, 7);
    const notFuture = revenueMonthOptions.filter(ym => ym <= nowYm);
    return (notFuture.length > 0 ? notFuture : revenueMonthOptions).slice(0, 2);
  }, [revenueMonthOptions]);

  // Default to the 2 most recent (non-future) months once data is available (only fires while empty)
  useEffect(() => {
    if (planViewMode === "revenue" && revenueMonthsF.size === 0 && sensibleDefaultMonths.length > 0) {
      setRevenueMonthsF(new Set(sensibleDefaultMonths));
    }
  }, [planViewMode, sensibleDefaultMonths, revenueMonthsF.size]);

  function toggleRevenueMonth(ym: string) {
    setRevenueMonthsF(prev => { const n = new Set(prev); n.has(ym) ? n.delete(ym) : n.add(ym); return n; });
  }

  /** "2026-07" -> "2026-06" (calendar month immediately before, regardless of what's selected/displayed) */
  function monthBefore(ym: string): string {
    const [y, m] = ym.split("-").map(Number);
    const d = new Date(Date.UTC(y, m - 2, 1)); // m is 1-indexed; m-2 = previous month, 0-indexed
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  }

  /** Walks backward from `ym` (inclusive) through months with no new billing event, as long as they're
   *  still "covered" by an earlier multi-month invoice, until it finds the last month with real booked
   *  revenue. Returns null once it hits a month that's neither billed nor covered — a genuine gap, not
   *  just a quiet month mid-way through an already-paid period. This is what lets a Jun–Dec period keep
   *  July–Nov from falsely reading as Churned/Downgrade, without splitting the dollars across those months. */
  function effectiveMonthState(entry: RevenueCustomerEntry, ym: string): { ym: string; amount: number; currency: string } | null {
    let cursor = ym;
    for (let i = 0; i < 60; i++) { // cap: 5 years back, plenty for any realistic gap
      const cell = entry.monthly.get(cursor);
      if (cell && cell.amount > 0) return { ym: cursor, amount: cell.amount, currency: cell.currency };
      if (!isCoveredInMonth(entry.coverage, cursor)) return null;
      cursor = monthBefore(cursor);
    }
    return null;
  }

  interface RevenueMonthCol {
    ym: string; amount: number; currency: string;
    prevYm: string; prevAmount: number; prevCurrency: string;
    /** "Upgrade" | "Downgrade" | "Currency Switch" | "New/Reactivated" | "Churned" | "Flat" | "—" */
    change_type: string;
    /** The specific invoice(s) that make up THIS month's amount — lets an upsell/downgrade be traced to its source invoice(s) */
    invoices: RevenueInvoiceRef[];
    /** WHY the total moved vs the previous real billing state: new/removed products, or price changes on existing ones */
    reasons: RevenueReason[];
  }
  interface RevenueRow {
    key: string; domain: string; customer_name: string; business: string; cs_email: string;
    account: "India" | "US"; customer_status: string;
    monthCols: RevenueMonthCol[]; // selected months, chronological (oldest → newest)
    /** Change type of the most recent selected month — used for the summary counts and sort order */
    change_type: string;
    /** Net change across the WHOLE selected range: last selected month minus first selected month.
     *  This is what answers "if I select a quarter, what's the net upsell/downgrade" — e.g. selecting
     *  Jan/Feb/Mar compares Mar directly against Jan, not against Feb. */
    net_first_ym?: string; net_first_amount?: number; net_first_currency?: string;
    net_last_ym?: string; net_last_amount?: number; net_last_currency?: string;
    /** Invoice(s) behind the last selected month's amount — the source of the net upsell/downgrade */
    net_last_invoices: RevenueInvoiceRef[];
    /** WHY the total moved across the whole selected range: last selected month's products vs first selected month's */
    net_reasons: RevenueReason[];
    net_change_type: string;
    net_delta: number;
  }
  const revenueRows = useMemo((): RevenueRow[] => {
    const selected = Array.from(revenueMonthsF).sort(); // chronological ascending
    const rows: RevenueRow[] = [];
    for (const [key, entry] of revenueByCustomer.entries()) {
      if (planAcctF !== "All" && entry.account !== planAcctF) continue;
      if (planSearch) {
        const q = planSearch.toLowerCase();
        if (![entry.customer_name, entry.domain, entry.business, entry.cs_email].some(v => v?.toLowerCase().includes(q))) continue;
      }
      const monthCols: RevenueMonthCol[] = selected.map(ym => {
        const cur = entry.monthly.get(ym);
        const amount = cur?.amount ?? 0; // RAW booked amount this month — did a real billing event happen?
        const currency = cur?.currency ?? "";
        const currCovered = isCoveredInMonth(entry.coverage, ym);
        const prevState = effectiveMonthState(entry, monthBefore(ym));
        const prevAmount = prevState?.amount ?? 0;
        const prevCurrency = prevState?.currency ?? "";
        const prevYm = prevState?.ym ?? monthBefore(ym);
        const prevHas = prevAmount > 0;

        let change_type = "—";
        if (amount > 0) {
          // A real invoice landed this month — compare against the last actual billing state.
          if (!prevHas) change_type = "New/Reactivated";
          else if (prevCurrency && currency && prevCurrency !== currency) change_type = "Currency Switch";
          else if (Math.abs(amount - prevAmount) < 0.01) change_type = "Flat";
          else change_type = amount > prevAmount ? "Upgrade" : "Downgrade";
        } else if (currCovered) {
          change_type = "—"; // mid-period quiet month, still actively covered — nothing to report
        } else if (prevHas) {
          change_type = "Churned"; // was active, no longer covered, and no new invoice this month
        }

        const reasons = (change_type === "Upgrade" || change_type === "Downgrade") ? diffProducts(cur?.products, entry.monthly.get(prevYm)?.products) : [];
        return { ym, amount, currency, prevYm, prevAmount, prevCurrency, change_type, invoices: cur?.invoices ?? [], reasons };
      });
      if (monthCols.length > 0 && monthCols.every(c => c.amount === 0 && c.prevAmount === 0)) continue; // nothing to show

      const latest = monthCols.length > 0 ? monthCols[monthCols.length - 1] : undefined;

      // Net change across the full selected range (e.g. a quarter): last selected month vs first —
      // using the same "effective state" logic, so picking a quiet-but-covered month as an endpoint
      // doesn't manufacture a fake churn/downgrade.
      let net_change_type = "—";
      let net_delta = 0;
      const firstCol = monthCols[0];
      const lastCol = monthCols[monthCols.length - 1];
      let net_first_eff: { ym: string; amount: number; currency: string } | null = null;
      let net_last_eff: { ym: string; amount: number; currency: string } | null = null;
      if (monthCols.length >= 2 && firstCol && lastCol) {
        net_first_eff = effectiveMonthState(entry, firstCol.ym);
        net_last_eff = effectiveMonthState(entry, lastCol.ym);
        const firstAmount = net_first_eff?.amount ?? 0, lastAmount = net_last_eff?.amount ?? 0;
        const firstCurrency = net_first_eff?.currency ?? "", lastCurrency = net_last_eff?.currency ?? "";
        const firstHas = firstAmount > 0, lastHas = lastAmount > 0;
        net_delta = lastAmount - firstAmount;
        if (!firstHas && lastHas) net_change_type = "New/Reactivated";
        else if (firstHas && !lastHas) net_change_type = "Churned";
        else if (firstHas && lastHas) {
          if (firstCurrency && lastCurrency && firstCurrency !== lastCurrency) net_change_type = "Currency Switch";
          else if (Math.abs(net_delta) < 0.01) net_change_type = "Flat";
          else net_change_type = net_delta > 0 ? "Upgrade" : "Downgrade";
        }
      }
      const net_reasons = (net_change_type === "Upgrade" || net_change_type === "Downgrade")
        ? diffProducts(entry.monthly.get(net_last_eff?.ym ?? "")?.products, entry.monthly.get(net_first_eff?.ym ?? "")?.products)
        : [];

      rows.push({
        key, domain: entry.domain, customer_name: entry.customer_name, business: entry.business, cs_email: entry.cs_email,
        account: entry.account, customer_status: entry.customer_status, monthCols,
        change_type: latest?.change_type ?? "—",
        net_first_ym: net_first_eff?.ym ?? firstCol?.ym, net_first_amount: net_first_eff?.amount ?? 0, net_first_currency: net_first_eff?.currency,
        net_last_ym: net_last_eff?.ym ?? lastCol?.ym, net_last_amount: net_last_eff?.amount ?? 0, net_last_currency: net_last_eff?.currency,
        net_last_invoices: entry.monthly.get(lastCol?.ym ?? "")?.invoices ?? [],
        net_reasons,
        net_change_type, net_delta,
      });
    }
    // Biggest net movers (over the whole selected range) first
    rows.sort((a, b) => Math.abs(b.net_delta) - Math.abs(a.net_delta));
    return rows;
  }, [revenueByCustomer, revenueMonthsF, planAcctF, planSearch]);

  const revenueUpgradeCount   = useMemo(() => revenueRows.filter(r => r.change_type === "Upgrade").length,   [revenueRows]);
  const revenueDowngradeCount = useMemo(() => revenueRows.filter(r => r.change_type === "Downgrade").length, [revenueRows]);

  /** Summarizes whether payment has actually come in for a set of invoices (used to check
   *  whether an upsell amount has actually been paid, not just invoiced). */
  function paymentStatus(invoices: RevenueInvoiceRef[]): { label: string; style: React.CSSProperties } | null {
    if (!invoices.length) return null;
    const paidCount = invoices.filter(iv => iv.status === "paid").length;
    if (paidCount === invoices.length) return { label: "✅ Payment Received", style: { color: "#065f46", background: "#d1fae5", border: "1px solid #6ee7b7" } };
    if (invoices.some(iv => iv.status === "uncollectible")) return { label: "⚠ Uncollectible", style: { color: "#7f1d1d", background: "#fee2e2", border: "1px solid #fca5a5" } };
    if (paidCount > 0) return { label: "◐ Partially Paid", style: { color: "#92400e", background: "#fef3c7", border: "1px solid #fcd34d" } };
    return { label: "⏳ Payment Pending", style: { color: "#92400e", background: "#fef3c7", border: "1px solid #fcd34d" } };
  }

  // Net $ amount summed across the whole filtered view, for the selected range (e.g. a quarter) —
  // only counted when the two ends of the range are in the same currency, same rule as everywhere else.
  const revenueNetUpsellTotals = useMemo(() => {
    const byCurrency = new Map<string, number>();
    for (const r of revenueRows) {
      if (r.net_change_type === "Upgrade" && r.net_last_currency) {
        byCurrency.set(r.net_last_currency, (byCurrency.get(r.net_last_currency) ?? 0) + r.net_delta);
      }
    }
    return byCurrency;
  }, [revenueRows]);
  const revenueNetDowngradeTotals = useMemo(() => {
    const byCurrency = new Map<string, number>();
    for (const r of revenueRows) {
      if (r.net_change_type === "Downgrade" && r.net_last_currency) {
        byCurrency.set(r.net_last_currency, (byCurrency.get(r.net_last_currency) ?? 0) + Math.abs(r.net_delta));
      }
    }
    return byCurrency;
  }, [revenueRows]);

  // ── Actions ───────────────────────────────────────────────────────────────
  function toggleSort(k: keyof CustRow) {
    if (sortCol === k) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortCol(k); setSortDir("desc"); }
  }
  function toggleExpand(key: string) {
    setExpanded(prev => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; });
  }
  function toggleLedgerExpand(key: string) {
    setLedgerExpanded(prev => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; });
  }
  function resetFilters() {
    setSearch(""); setAcctF("All"); setStatF("All"); setBizF("All"); setCsF("All"); setPmF("All");
    setB0_30F("All"); setB31_60F("All"); setB61_90F("All"); setB90_180F("All"); setB180plusF("All");
    setDsoF("All"); setTotalF("All");
  }

  function downloadCSV() {
    const headers = ["Domain","Customer","Account","Status","Business","CS Owner","Payment","0-30d","31-60d","61-90d","90-180d","180+d","Total (USD)","DSO (days)","Sales 3M (USD)"];
    const rows = displayRows.map(r => [
      r.domain, r.customer_name, r.account, r.customer_status, r.business, r.cs_email,
      r.collection_method === "charge_automatically" ? "Auto" : "Manual",
      r.b0_30.toFixed(2), r.b31_60.toFixed(2), r.b61_90.toFixed(2), r.b90_180.toFixed(2), r.b180plus.toFixed(2),
      r.total.toFixed(2), String(r.dso_days), r.sales_3m_usd.toFixed(2),
    ]);
    const csv = "﻿" + [headers, ...rows]
      .map(row => row.map(c => `"${String(c).replace(/"/g, '""')}"`).join(","))
      .join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    a.download = `outstanding-${new Date().toISOString().split("T")[0]}.csv`;
    a.click();
  }

  function downloadDSOCSV() {
    const headers = ["Domain","Customer","Account","Status","Business","CS Owner","Currency","Outstanding","DSO (days)","Sales 3M (USD)","Payment"];
    const rows = (data?.dso ?? []).map(d => [
      d.domain, d.customer_name, d.account, d.customer_status, d.business, d.cs_email,
      d.currency, d.total_outstanding.toFixed(2), String(d.dso_days),
      (d as any).sales_3m_usd?.toFixed(2) ?? "0",
      d.collection_method === "charge_automatically" ? "Auto" : "Manual",
    ]);
    const csv = "﻿" + [headers, ...rows]
      .map(row => row.map(c => `"${String(c).replace(/"/g, '""')}"`).join(","))
      .join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    a.download = `dso-all-customers-${new Date().toISOString().split("T")[0]}.csv`;
    a.click();
  }
  // ── Generic download helpers ───────────────────────────────────────────────
  function downloadBlob(content: BlobPart, filename: string, type: string) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([content], { type }));
    a.download = filename;
    a.click();
  }
  function toCSV(headers: string[], rows: (string | number)[][]): string {
    return "﻿" + [headers, ...rows]
      .map(row => row.map(c => `"${String(c).replace(/"/g, '""')}"`).join(","))
      .join("\n");
  }

  // ── "All Customers Data" (ledger) exports ─────────────────────────────────
  const ledgerSummaryHeaders = ["Domain","Customer","Email","Account","Status","Business","CS Owner","Payment","Start Date","Latest Invoice","# Invoices"];
  function ledgerSummaryRows(): (string | number)[][] {
    return ledgerRows.map(c => [
      c.domain, c.customer_name, c.customer_email, c.account, c.customer_status, c.business, c.cs_email,
      c.collection_method === "charge_automatically" ? "Auto" : "Manual",
      c.first_invoice_date ?? "", c.latest_invoice_date ?? "", c.invoices.length,
    ]);
  }
  const ledgerInvoiceHeaders = ["Domain","Customer","Account","Invoice #","Status","Currency","Amount","Amount Paid","Invoice Date","Due Date","Period Start","Period End","Payment"];
  function ledgerInvoiceRows(): (string | number)[][] {
    const rows: (string | number)[][] = [];
    for (const c of ledgerRows) {
      for (const inv of c.invoices) {
        rows.push([
          c.domain, c.customer_name, c.account, inv.invoice_number, inv.status, inv.currency,
          inv.amount.toFixed(2), inv.amount_paid.toFixed(2), inv.invoice_date, inv.due_date ?? "",
          inv.period_start ?? "", inv.period_end ?? "",
          c.collection_method === "charge_automatically" ? "Auto" : "Manual",
        ]);
      }
    }
    return rows;
  }
  function downloadLedgerSummaryCSV() {
    downloadBlob(toCSV(ledgerSummaryHeaders, ledgerSummaryRows()), `all-customers-summary-${new Date().toISOString().split("T")[0]}.csv`, "text/csv;charset=utf-8");
  }
  function downloadLedgerInvoicesCSV() {
    downloadBlob(toCSV(ledgerInvoiceHeaders, ledgerInvoiceRows()), `all-customers-invoices-${new Date().toISOString().split("T")[0]}.csv`, "text/csv;charset=utf-8");
  }
  function downloadLedgerExcel() {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([ledgerSummaryHeaders, ...ledgerSummaryRows()]), "Summary");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([ledgerInvoiceHeaders, ...ledgerInvoiceRows()]), "Invoices");
    XLSX.writeFile(wb, `all-customers-${new Date().toISOString().split("T")[0]}.xlsx`);
  }

  // ── Plan changes (upgrade/downgrade) exports ──────────────────────────────
  const planHeaders = ["Detected At","Domain","Customer","Account","Business","CS Owner","Change Type","Previous Plan","Previous Value","Previous Currency","New Plan","New Value","New Currency"];
  function planRowsForExport(): (string | number)[][] {
    return planRows.map(c => [
      c.detected_at, c.domain, c.customer_name, c.account, c.business, c.cs_email, c.change_type,
      c.previous_plan, c.previous_value.toFixed(2), c.previous_currency,
      c.new_plan, c.new_value.toFixed(2), c.new_currency,
    ]);
  }
  function downloadPlanCSV() {
    downloadBlob(toCSV(planHeaders, planRowsForExport()), `plan-changes-${new Date().toISOString().split("T")[0]}.csv`, "text/csv;charset=utf-8");
  }
  function downloadPlanExcel() {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([planHeaders, ...planRowsForExport()]), "Plan Changes");
    XLSX.writeFile(wb, `plan-changes-${new Date().toISOString().split("T")[0]}.xlsx`);
  }

  // ── Revenue month-over-month exports ──────────────────────────────────────
  function invoiceRefsToText(invs: RevenueInvoiceRef[]): string {
    if (!invs.length) return "";
    return invs.map(iv => `${iv.invoice_number} (raised ${iv.invoice_date}${iv.paid_at ? `, paid ${iv.paid_at}` : `, ${iv.status}`})`).join("; ");
  }
  function reasonsToText(reasons: RevenueReason[], currency: string): string {
    if (!reasons.length) return "";
    return reasons.map(rs => `${rs.type}: ${rs.name} (${rs.delta > 0 ? "+" : "-"}${currency} ${Math.abs(rs.delta).toFixed(2)})`).join("; ");
  }
  function paymentStatusText(invoices: RevenueInvoiceRef[]): string {
    const s = paymentStatus(invoices);
    return s ? s.label.replace(/^[^\w]*/, "") : ""; // strip the leading emoji for plain-text export
  }
  function revenueHeaders(): string[] {
    const monthHeaders = Array.from(revenueMonthsF).sort().flatMap(ym => [planMonthLabel(ym), `${planMonthLabel(ym)} vs Prev Month`, `${planMonthLabel(ym)} Reason`, `${planMonthLabel(ym)} Payment Status`, `${planMonthLabel(ym)} Source Invoice(s)`]);
    return ["Domain","Customer","Account","Business","CS Owner", ...monthHeaders, "Net Change (Selected Range)", "Net Change Amount", "Net Change Reason", "Net Change Payment Status", "Net Change Source Invoice(s)"];
  }
  function revenueRowsForExport(): (string | number)[][] {
    return revenueRows.map(r => [
      r.domain, r.customer_name, r.account, r.business, r.cs_email,
      ...r.monthCols.flatMap(c => [
        c.amount > 0 ? `${c.currency} ${c.amount.toFixed(2)}` : "—",
        c.change_type,
        reasonsToText(c.reasons, c.currency),
        (c.change_type === "Upgrade" || c.change_type === "Downgrade") ? paymentStatusText(c.invoices) : "",
        (c.change_type === "Upgrade" || c.change_type === "Downgrade") ? invoiceRefsToText(c.invoices) : "",
      ]),
      r.net_change_type,
      r.net_change_type === "—" ? "" : `${r.net_last_currency} ${r.net_delta.toFixed(2)}`,
      reasonsToText(r.net_reasons, r.net_last_currency ?? ""),
      (r.net_change_type === "Upgrade" || r.net_change_type === "Downgrade") ? paymentStatusText(r.net_last_invoices) : "",
      (r.net_change_type === "Upgrade" || r.net_change_type === "Downgrade") ? invoiceRefsToText(r.net_last_invoices) : "",
    ]);
  }
  function downloadRevenueCSV() {
    downloadBlob(toCSV(revenueHeaders(), revenueRowsForExport()), `revenue-month-over-month-${new Date().toISOString().split("T")[0]}.csv`, "text/csv;charset=utf-8");
  }
  function downloadRevenueExcel() {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([revenueHeaders(), ...revenueRowsForExport()]), "Revenue MoM");
    XLSX.writeFile(wb, `revenue-month-over-month-${new Date().toISOString().split("T")[0]}.xlsx`);
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

  // ── Sub-components ────────────────────────────────────────────────────────
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

  // ── Aging mode toggle ─────────────────────────────────────────────────────
  const AgingModeToggle = () => (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span style={{ fontSize: 11, color: "#64748b", fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: 0.5, whiteSpace: "nowrap" }}>Age from:</span>
      <div style={{ display: "flex", background: "#f1f5f9", borderRadius: 7, padding: 2, gap: 1 }}>
        <button
          onClick={() => setAgingMode("due_date")}
          style={{
            fontSize: 11, fontWeight: 700, padding: "4px 12px", borderRadius: 5, border: "none", cursor: "pointer",
            background: agingMode === "due_date" ? "#6366f1" : "transparent",
            color: agingMode === "due_date" ? "#fff" : "#64748b",
            transition: "all 0.15s",
          }}>
          Due Date
        </button>
        <button
          onClick={() => setAgingMode("invoice_date")}
          style={{
            fontSize: 11, fontWeight: 700, padding: "4px 12px", borderRadius: 5, border: "none", cursor: "pointer",
            background: agingMode === "invoice_date" ? "#6366f1" : "transparent",
            color: agingMode === "invoice_date" ? "#fff" : "#64748b",
            transition: "all 0.15s",
          }}>
          Invoice Date
        </button>
      </div>
      {agingMode === "due_date" && (
        <span style={{ fontSize: 10, color: "#94a3b8", fontStyle: "italic" }}>
          (autopay without due date uses invoice date)
        </span>
      )}
    </div>
  );

  // ── Loading / Error ───────────────────────────────────────────────────────
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

  // ── Render ────────────────────────────────────────────────────────────────
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
      <div style={{ ...S.tabBar, width: "auto" }}>
        {([
          { key: "all",      label: "Customers with O/S Amount" },
          { key: "active",   label: "Active" },
          { key: "inactive", label: "Inactive" },
          { key: "autopay",  label: "🤖 Auto Pay" },
          { key: "manual",   label: "📧 Manual" },
          { key: "ledger",   label: "📋 All Customers Data" },
          { key: "planChanges", label: "📈 Plan Changes" },
        ] as const).map(({ key, label }) => (
          <button key={key} onClick={() => { setActiveTab(key); setBizF("All"); setPmTabExpanded(false); }}
            style={{ ...S.tab, ...(activeTab === key ? S.tabActive : {}) }}>
            {label}
          </button>
        ))}
      </div>

      {/* ── LEDGER TAB ── */}
      {activeTab === "ledger" && (
        <div>
          {/* Ledger header */}
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
            <div style={{ fontSize: 13, color: "#64748b", fontWeight: 600 }}>
              All active customers · last 18 months · cached up to 10 min
            </div>
            <button
              onClick={() => loadLedger(true)}
              disabled={ledgerLoading}
              style={{ fontSize: 12, background: "rgba(99,102,241,0.08)", color: "#6366f1", border: "1px solid #c7d2fe", borderRadius: 8, padding: "6px 14px", fontWeight: 700, cursor: "pointer" }}>
              {ledgerLoading ? "⟳ Loading..." : "⟳ Refresh"}
            </button>
            <button onClick={downloadLedgerSummaryCSV} style={{ fontSize: 12, background: "#f0fdf4", color: "#16a34a", border: "1px solid #86efac", borderRadius: 8, padding: "5px 12px", cursor: "pointer", fontWeight: 600 }}>
              ⬇ CSV (Summary)
            </button>
            <button onClick={downloadLedgerInvoicesCSV} style={{ fontSize: 12, background: "#eff6ff", color: "#2563eb", border: "1px solid #93c5fd", borderRadius: 8, padding: "5px 12px", cursor: "pointer", fontWeight: 600 }}>
              ⬇ CSV (Invoices)
            </button>
            <button onClick={downloadLedgerExcel} style={{ fontSize: 12, background: "#f0f9ff", color: "#0369a1", border: "1px solid #7dd3fc", borderRadius: 8, padding: "5px 12px", cursor: "pointer", fontWeight: 600 }}>
              ⬇ Excel (.xlsx)
            </button>
          </div>

          {ledgerLoading && (
            <div style={S.center}>
              <div style={S.spin} />
              <p style={{ marginTop: 16, color: "#64748b", fontSize: 14 }}>Fetching all invoices from Stripe (this may take 20–40s)...</p>
            </div>
          )}

          {ledgerError && (
            <div style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 10, padding: "16px 20px", color: "#dc2626", marginBottom: 16 }}>
              ⚠ {ledgerError}
            </div>
          )}

          {!ledgerLoading && ledgerData && (
            <>
              {/* Ledger filter bar */}
              <div style={{ marginBottom: 12, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", background: "#fff", padding: "12px 16px", borderRadius: 10, boxShadow: "0 1px 3px rgba(0,0,0,0.05)" }}>
                <input
                  style={S.searchInput}
                  placeholder="🔍  Search domain, customer, email..."
                  value={ledgerSearch}
                  onChange={e => setLedgerSearch(e.target.value)}
                />
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <label style={{ fontSize: 11, color: "#64748b", fontWeight: 700, whiteSpace: "nowrap" }}>Account</label>
                  <select style={{ ...sel, width: 100 }} value={ledgerAcctF} onChange={e => setLedgerAcctF(e.target.value)}>
                    <option value="All">All</option>
                    <option value="India">India</option>
                    <option value="US">US</option>
                  </select>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <label style={{ fontSize: 11, color: "#64748b", fontWeight: 700, whiteSpace: "nowrap" }}>Status</label>
                  <select style={{ ...sel, width: 120 }} value={ledgerStatF} onChange={e => setLedgerStatF(e.target.value)}>
                    <option value="All">All</option>
                    {ledgerStatOptions.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <label style={{ fontSize: 11, color: "#64748b", fontWeight: 700, whiteSpace: "nowrap" }}>Business</label>
                  <select style={{ ...sel, width: 140 }} value={ledgerBizF} onChange={e => setLedgerBizF(e.target.value)}>
                    <option value="All">All</option>
                    {ledgerBizOptions.map(b => <option key={b} value={b}>{b}</option>)}
                  </select>
                </div>
                <span style={{ fontSize: 13, color: "#64748b", fontWeight: 500 }}>{ledgerRows.length} customers</span>
                {(ledgerSearch || ledgerAcctF !== "All" || ledgerStatF !== "All" || ledgerBizF !== "All") && (
                  <button
                    onClick={() => { setLedgerSearch(""); setLedgerAcctF("All"); setLedgerStatF("All"); setLedgerBizF("All"); }}
                    style={{ fontSize: 12, color: "#ef4444", background: "#fee2e2", border: "1px solid #fca5a5", borderRadius: 20, padding: "4px 12px", cursor: "pointer", fontWeight: 600 }}>
                    ✕ Clear
                  </button>
                )}
              </div>

              {/* Ledger table */}
              <div style={S.tableWrap}>
                <table style={S.table}>
                  <thead>
                    <tr>
                      {([
                        { label: "Domain",          col: "domain" },
                        { label: "Account",         col: null },
                        { label: "Status",          col: null },
                        { label: "Business",        col: null },
                        { label: "CS Owner",        col: null },
                        { label: "Payment",         col: null },
                        { label: "Start Date",      col: "first_invoice_date" },
                        { label: "Latest Invoice",  col: "latest_invoice_date" },
                        { label: "# Invoices",      col: null },
                        { label: "Actions",         col: null },
                      ] as { label: string; col: string | null }[]).map(({ label, col }) => (
                        <th
                          key={label}
                          onClick={col ? () => {
                            if (ledgerSortCol === col) setLedgerSortDir(d => d === "asc" ? "desc" : "asc");
                            else { setLedgerSortCol(col as typeof ledgerSortCol); setLedgerSortDir("desc"); }
                          } : undefined}
                          style={{ ...S.th, color: "#475569", cursor: col ? "pointer" : "default", userSelect: "none" }}>
                          {label}{col && ledgerSortCol === col ? (ledgerSortDir === "asc" ? " ↑" : " ↓") : ""}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {ledgerRows.length === 0 ? (
                      <tr><td colSpan={10} style={{ textAlign: "center", padding: 48, color: "#94a3b8" }}>
                        <div style={{ fontSize: 32, marginBottom: 8 }}>🔍</div>
                        <div style={{ fontWeight: 600 }}>No customers match your filters</div>
                      </td></tr>
                    ) : ledgerRows.map((cust, i) => {
                      const isExp = ledgerExpanded.has(cust.customer_id);
                      const rowBg = i % 2 === 0 ? "#fff" : "#fafbff";
                      const [bizFg, bizBg, bizBorder] = cust.business ? bizColor(cust.business) : ["#6b7280", "#f3f4f6", "#e5e7eb"];

                      return (
                        <>
                          <tr
                            key={cust.customer_id}
                            style={{ background: rowBg }}
                            onMouseEnter={e => (e.currentTarget.style.background = "#f0f4ff")}
                            onMouseLeave={e => (e.currentTarget.style.background = rowBg)}>
                            <td style={S.td}>
                              <div style={{ fontWeight: 600, fontSize: 13, color: "#0f172a" }}>{cust.domain || "—"}</div>
                              <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 1 }}>{cust.customer_name}</div>
                              <div style={{ fontSize: 10, color: "#cbd5e1", marginTop: 1 }}>{cust.customer_email}</div>
                            </td>
                            <td style={S.td}><span style={acctStyle(cust.account)}>{cust.account}</span></td>
                            <td style={S.td}>{cust.customer_status ? <span style={statusStyle(cust.customer_status)}>{cust.customer_status}</span> : <span style={{ color: "#cbd5e1" }}>—</span>}</td>
                            <td style={S.td}>{cust.business ? <span style={{ background: bizBg, color: bizFg, border: `1px solid ${bizBorder}`, borderRadius: 20, padding: "3px 10px", fontSize: 12, fontWeight: 700 }}>{cust.business}</span> : <span style={{ color: "#cbd5e1" }}>—</span>}</td>
                            <td style={S.td}><span style={{ fontSize: 12, color: "#475569" }}>{cust.cs_email?.split("@")[0] || "—"}</span></td>
                            <td style={S.td}>
                              {cust.collection_method === "charge_automatically"
                                ? <span style={{ background: "#ede9fe", color: "#6366f1", borderRadius: 20, padding: "3px 10px", fontSize: 11, fontWeight: 700, border: "1px solid #c4b5fd" }}>🤖 Auto</span>
                                : <span style={{ background: "#fef9c3", color: "#92400e", borderRadius: 20, padding: "3px 10px", fontSize: 11, fontWeight: 700, border: "1px solid #fde68a" }}>📧 Manual</span>}
                            </td>
                            <td style={{ ...S.td, fontSize: 12, color: "#475569" }}>{fmtDate(cust.first_invoice_date)}</td>
                            <td style={{ ...S.td, fontSize: 12, color: "#475569" }}>{fmtDate(cust.latest_invoice_date)}</td>
                            <td style={{ ...S.td, fontWeight: 700, color: "#4338ca", cursor: "pointer", userSelect: "none" }}
                              onClick={() => toggleLedgerExpand(cust.customer_id)}>
                              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                                <span style={{ fontSize: 10, background: "#ede9fe", color: "#6366f1", borderRadius: 10, padding: "2px 8px", fontWeight: 700 }}>
                                  {isExp ? "▲" : "▼"} {cust.invoices.length}
                                </span>
                              </div>
                            </td>
                            <td style={S.td}>
                              <button
                                onClick={() => toggleLedgerExpand(cust.customer_id)}
                                style={{ fontSize: 11, background: isExp ? "#ede9fe" : "#f8fafc", color: "#6366f1", border: "1px solid #c4b5fd", borderRadius: 6, padding: "4px 10px", cursor: "pointer", fontWeight: 600 }}>
                                {isExp ? "▲ Collapse" : "▼ View Invoices"}
                              </button>
                            </td>
                          </tr>

                          {/* ── Expanded invoice rows ── */}
                          {isExp && (
                            <>
                              <tr style={{ background: "#f5f3ff" }}>
                                <td colSpan={10} style={{ padding: "6px 14px 4px", borderLeft: "3px solid #818cf8" }}>
                                  <div style={{ display: "flex", gap: 20, fontSize: 10, fontWeight: 700, color: "#6366f1", textTransform: "uppercase" as const, letterSpacing: 0.6 }}>
                                    <span style={{ minWidth: 130 }}>Invoice #</span>
                                    <span style={{ minWidth: 100 }}>Invoice Date</span>
                                    <span style={{ minWidth: 100 }}>Due Date</span>
                                    <span style={{ minWidth: 160 }}>Service Period</span>
                                    <span style={{ minWidth: 80 }}>Status</span>
                                    <span style={{ minWidth: 100 }}>Amount</span>
                                    <span>Actions</span>
                                  </div>
                                </td>
                              </tr>
                              {cust.invoices.map((inv: AllCustomerInvoice) => (
                                <tr key={inv.id} style={{ background: "#f5f3ff", borderLeft: "3px solid #818cf8" }}>
                                  <td colSpan={10} style={{ padding: "7px 14px", borderBottom: "1px solid #ede9fe" }}>
                                    <div style={{ display: "flex", gap: 20, alignItems: "center", flexWrap: "wrap" }}>
                                      <span style={{ minWidth: 130, fontFamily: "monospace", color: "#6366f1", fontWeight: 700, fontSize: 12 }}>
                                        {inv.invoice_number}
                                      </span>
                                      <span style={{ minWidth: 100, fontSize: 12, color: "#475569" }}>
                                        {fmtDate(inv.invoice_date)}
                                      </span>
                                      <span style={{ minWidth: 100, fontSize: 12, color: inv.due_date ? "#475569" : "#94a3b8" }}>
                                        {fmtDate(inv.due_date) || "—"}
                                      </span>
                                      <span style={{ minWidth: 160, fontSize: 11, color: "#64748b" }}>
                                        {inv.period_start && inv.period_end
                                          ? `${fmtDate(inv.period_start)} → ${fmtDate(inv.period_end)}`
                                          : "—"}
                                      </span>
                                      <span style={{ minWidth: 80 }}>
                                        <span style={invoiceStatusStyle(inv.status)}>{inv.status}</span>
                                      </span>
                                      <span style={{ minWidth: 100, fontWeight: 700, fontSize: 13, color: "#0f172a" }}>
                                        {inv.currency} {inv.amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                        {inv.status === "paid" && inv.amount_paid < inv.amount && (
                                          <span style={{ fontSize: 10, color: "#f59e0b", marginLeft: 4 }}>
                                            (paid {inv.currency} {inv.amount_paid.toLocaleString()})
                                          </span>
                                        )}
                                      </span>
                                      <span style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                                        {inv.invoice_url && (
                                          <a href={inv.invoice_url} target="_blank" rel="noreferrer"
                                            style={{ fontSize: 11, color: "#6366f1", background: "#ede9fe", border: "1px solid #c4b5fd", borderRadius: 6, padding: "3px 8px", fontWeight: 600, textDecoration: "none" }}>
                                            🔗 View
                                          </a>
                                        )}
                                        {inv.invoice_pdf && (
                                          <a href={inv.invoice_pdf} target="_blank" rel="noreferrer" download
                                            style={{ fontSize: 11, color: "#0891b2", background: "#ecfeff", border: "1px solid #a5f3fc", borderRadius: 6, padding: "3px 8px", fontWeight: 600, textDecoration: "none" }}>
                                            ⬇ PDF
                                          </a>
                                        )}
                                        {inv.receipt_url && inv.status === "paid" && (
                                          <a href={inv.receipt_url} target="_blank" rel="noreferrer"
                                            style={{ fontSize: 11, color: "#059669", background: "#ecfdf5", border: "1px solid #6ee7b7", borderRadius: 6, padding: "3px 8px", fontWeight: 600, textDecoration: "none" }}>
                                            🧾 Receipt
                                          </a>
                                        )}
                                      </span>
                                    </div>
                                    {inv.description && (
                                      <div style={{ fontSize: 10, color: "#94a3b8", marginTop: 3, paddingLeft: 0 }}>
                                        {inv.description.slice(0, 100)}
                                      </div>
                                    )}
                                  </td>
                                </tr>
                              ))}
                            </>
                          )}
                        </>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div style={{ textAlign: "center", padding: "12px 0", color: "#94a3b8", fontSize: 12 }}>
                Showing customers with invoices in last 18 months · Excludes churned with no activity in 3 months
              </div>
            </>
          )}
        </div>
      )}

      {/* ── PLAN CHANGES (UPGRADE/DOWNGRADE) TAB ── */}
      {activeTab === "planChanges" && (
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
            <div style={{ display: "flex", background: "#f1f5f9", borderRadius: 8, padding: 3, gap: 2 }}>
              <button
                onClick={() => setPlanViewMode("tier")}
                style={{ fontSize: 12, fontWeight: 700, padding: "6px 14px", borderRadius: 6, border: "none", cursor: "pointer",
                  background: planViewMode === "tier" ? "#6366f1" : "transparent", color: planViewMode === "tier" ? "#fff" : "#64748b" }}>
                🎚 Subscription Tier
              </button>
              <button
                onClick={() => setPlanViewMode("revenue")}
                style={{ fontSize: 12, fontWeight: 700, padding: "6px 14px", borderRadius: 6, border: "none", cursor: "pointer",
                  background: planViewMode === "revenue" ? "#6366f1" : "transparent", color: planViewMode === "revenue" ? "#fff" : "#64748b" }}>
                💰 Monthly Revenue
              </button>
            </div>
            <div style={{ fontSize: 13, color: "#64748b", fontWeight: 600 }}>
              {planViewMode === "tier"
                ? "Detected from Stripe subscription price/tier changes · currency-only switches excluded from Upgrade/Downgrade counts"
                : "Compares total invoiced amount month-over-month, per customer · currency-only differences excluded from Upgrade/Downgrade counts"}
            </div>
            {planViewMode === "tier" ? (
              <>
                <button
                  onClick={loadPlanChanges}
                  disabled={planLoading}
                  style={{ fontSize: 12, background: "rgba(99,102,241,0.08)", color: "#6366f1", border: "1px solid #c7d2fe", borderRadius: 8, padding: "6px 14px", fontWeight: 700, cursor: "pointer" }}>
                  {planLoading ? "⟳ Checking..." : "⟳ Check for changes"}
                </button>
                <button onClick={downloadPlanCSV} style={{ fontSize: 12, background: "#f0fdf4", color: "#16a34a", border: "1px solid #86efac", borderRadius: 8, padding: "5px 12px", cursor: "pointer", fontWeight: 600 }}>
                  ⬇ CSV
                </button>
                <button onClick={downloadPlanExcel} style={{ fontSize: 12, background: "#f0f9ff", color: "#0369a1", border: "1px solid #7dd3fc", borderRadius: 8, padding: "5px 12px", cursor: "pointer", fontWeight: 600 }}>
                  ⬇ Excel (.xlsx)
                </button>
              </>
            ) : (
              <>
                <button
                  onClick={() => loadLedger(true)}
                  disabled={ledgerLoading}
                  style={{ fontSize: 12, background: "rgba(99,102,241,0.08)", color: "#6366f1", border: "1px solid #c7d2fe", borderRadius: 8, padding: "6px 14px", fontWeight: 700, cursor: "pointer" }}>
                  {ledgerLoading ? "⟳ Loading..." : "⟳ Refresh"}
                </button>
                <button onClick={downloadRevenueCSV} style={{ fontSize: 12, background: "#f0fdf4", color: "#16a34a", border: "1px solid #86efac", borderRadius: 8, padding: "5px 12px", cursor: "pointer", fontWeight: 600 }}>
                  ⬇ CSV
                </button>
                <button onClick={downloadRevenueExcel} style={{ fontSize: 12, background: "#f0f9ff", color: "#0369a1", border: "1px solid #7dd3fc", borderRadius: 8, padding: "5px 12px", cursor: "pointer", fontWeight: 600 }}>
                  ⬇ Excel (.xlsx)
                </button>
              </>
            )}
          </div>

          {planViewMode === "tier" && (
          <>
          {!planLoading && planData && (
            <div style={{ display: "flex", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
              <div style={{ background: "#fff", border: "1px solid #bbf7d0", borderRadius: 10, padding: "12px 18px" }}>
                <div style={{ fontSize: 11, color: "#16a34a", fontWeight: 700, textTransform: "uppercase" as const }}>⬆ Upgrades</div>
                <div style={{ fontSize: 22, fontWeight: 800, color: "#16a34a" }}>{planUpgradeCount}</div>
              </div>
              <div style={{ background: "#fff", border: "1px solid #fecaca", borderRadius: 10, padding: "12px 18px" }}>
                <div style={{ fontSize: 11, color: "#dc2626", fontWeight: 700, textTransform: "uppercase" as const }}>⬇ Downgrades</div>
                <div style={{ fontSize: 22, fontWeight: 800, color: "#dc2626" }}>{planDowngradeCount}</div>
              </div>
            </div>
          )}

          {!planLoading && planData && planData.subscriptions_found === 0 && (
            <div style={{ background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 10, padding: "14px 20px", color: "#92400e", marginBottom: 16, fontSize: 13 }}>
              ⚠ Stripe returned <b>0 active/trialing subscription objects</b> across both accounts. This tab tracks changes to Stripe <b>Subscription</b> price/tier — if your customers are invoiced directly (one-off invoices, not attached to a Stripe Subscription), there's nothing here to track and this view will stay empty. The <b>💰 Monthly Revenue</b> view (based on actual invoices) is the one that will show data for that billing setup.
            </div>
          )}

          {!planLoading && planData && planCurrentRows.length > 0 && (
            <div style={{ marginBottom: 20 }}>
              <div style={S.sectionLabel}>Current Subscriptions (as of last check)</div>
              <div style={S.tableWrap}>
                <table style={S.table}>
                  <thead>
                    <tr>
                      {["Domain","Account","Business","CS Owner","Currency","Plan Value","Plan Summary","Status"].map(label => (
                        <th key={label} style={{ ...S.th, color: "#475569" }}>{label}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {planCurrentRows.map((c, i) => {
                      const rowBg = i % 2 === 0 ? "#fff" : "#fafbff";
                      const statusStyle: React.CSSProperties =
                        c.status === "Upgrade"   ? { color: "#065f46", background: "#d1fae5", border: "1px solid #6ee7b7" } :
                        c.status === "Downgrade" ? { color: "#7f1d1d", background: "#fee2e2", border: "1px solid #fca5a5" } :
                        c.status === "Currency Switch" ? { color: "#92400e", background: "#fef3c7", border: "1px solid #fcd34d" } :
                        c.status === "Baseline" ? { color: "#075985", background: "#e0f2fe", border: "1px solid #7dd3fc" } :
                        c.status === "No Change" ? { color: "#64748b", background: "#f1f5f9", border: "1px solid #e2e8f0" } :
                        { color: "#374151", background: "#f3f4f6", border: "1px solid #d1d5db" };
                      return (
                        <tr key={`${c.account}-${c.customer_id}`} style={{ background: rowBg }}>
                          <td style={S.td}>
                            <div style={{ fontWeight: 600, fontSize: 13, color: "#0f172a" }}>{c.domain || "—"}</div>
                            <div style={{ fontSize: 11, color: "#94a3b8" }}>{c.customer_name}</div>
                          </td>
                          <td style={S.td}><span style={acctStyle(c.account)}>{c.account}</span></td>
                          <td style={S.td}>{c.business || <span style={{ color: "#cbd5e1" }}>—</span>}</td>
                          <td style={S.td}><span style={{ fontSize: 12, color: "#475569" }}>{c.cs_email?.split("@")[0] || "—"}</span></td>
                          <td style={S.td}>{c.currency}</td>
                          <td style={{ ...S.td, fontWeight: 700 }}>{c.plan_value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                          <td style={{ ...S.td, fontSize: 12, color: "#64748b" }}>{c.plan_summary || "—"}</td>
                          <td style={S.td}>
                            <span style={{ borderRadius: 20, padding: "3px 10px", fontSize: 11, fontWeight: 700, display: "inline-block", whiteSpace: "nowrap", ...statusStyle }}>
                              {c.status === "Upgrade" ? "⬆ " : c.status === "Downgrade" ? "⬇ " : ""}{c.status}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {planLoading && (
            <div style={S.center}>
              <div style={S.spin} />
              <p style={{ marginTop: 16, color: "#64748b", fontSize: 14 }}>Comparing current Stripe subscriptions against the last known snapshot...</p>
            </div>
          )}

          {planError && (
            <div style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 10, padding: "16px 20px", color: "#dc2626", marginBottom: 16 }}>
              ⚠ {planError}
            </div>
          )}

          {!planLoading && planData && (
            <>
              <div style={{ marginBottom: 12, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", background: "#fff", padding: "12px 16px", borderRadius: 10, boxShadow: "0 1px 3px rgba(0,0,0,0.05)" }}>
                <input
                  style={S.searchInput}
                  placeholder="🔍  Search domain, customer, business..."
                  value={planSearch}
                  onChange={e => setPlanSearch(e.target.value)}
                />
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <label style={{ fontSize: 11, color: "#64748b", fontWeight: 700, whiteSpace: "nowrap" }}>Account</label>
                  <select style={{ ...sel, width: 100 }} value={planAcctF} onChange={e => setPlanAcctF(e.target.value)}>
                    <option value="All">All</option>
                    <option value="India">India</option>
                    <option value="US">US</option>
                  </select>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <label style={{ fontSize: 11, color: "#64748b", fontWeight: 700, whiteSpace: "nowrap" }}>Type</label>
                  <select style={{ ...sel, width: 140 }} value={planTypeF} onChange={e => setPlanTypeF(e.target.value as typeof planTypeF)}>
                    <option value="All">All</option>
                    <option value="Upgrade">Upgrade</option>
                    <option value="Downgrade">Downgrade</option>
                    <option value="Currency Switch">Currency Switch</option>
                    <option value="Plan Changed">Plan Changed</option>
                  </select>
                </div>
                <div style={{ position: "relative" }}>
                  <label style={{ fontSize: 11, color: "#64748b", fontWeight: 700, whiteSpace: "nowrap", marginRight: 6 }}>Month</label>
                  <button
                    onClick={() => setPlanMonthPickerOpen(v => !v)}
                    style={{ ...sel, width: "auto", minWidth: 140, textAlign: "left", display: "inline-flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                    <span>
                      {planMonthsF.size === 0
                        ? "All months"
                        : planMonthsF.size <= 2
                          ? Array.from(planMonthsF).sort().reverse().map(planMonthLabel).join(", ")
                          : `${planMonthsF.size} months selected`}
                    </span>
                    <span style={{ fontSize: 10 }}>{planMonthPickerOpen ? "▲" : "▼"}</span>
                  </button>
                  {planMonthPickerOpen && (
                    <div style={{
                      position: "absolute", top: "100%", left: 0, marginTop: 4, zIndex: 20,
                      background: "#fff", border: "1px solid #e2e8f0", borderRadius: 8,
                      boxShadow: "0 4px 16px rgba(0,0,0,0.12)", padding: 10, minWidth: 180, maxHeight: 240, overflowY: "auto",
                    }}>
                      {planMonthOptions.length === 0 ? (
                        <div style={{ fontSize: 12, color: "#94a3b8", padding: "4px 6px" }}>No dated changes yet</div>
                      ) : planMonthOptions.map(ym => (
                        <label key={ym} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "#374151", padding: "4px 6px", cursor: "pointer", borderRadius: 5 }}>
                          <input type="checkbox" checked={planMonthsF.has(ym)} onChange={() => togglePlanMonth(ym)} />
                          {planMonthLabel(ym)}
                        </label>
                      ))}
                      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8, paddingTop: 8, borderTop: "1px solid #f1f5f9" }}>
                        <button
                          onClick={() => setPlanMonthsF(new Set())}
                          style={{ fontSize: 11, color: "#ef4444", background: "none", border: "none", cursor: "pointer", fontWeight: 600 }}>
                          Clear
                        </button>
                        <button
                          onClick={() => setPlanMonthPickerOpen(false)}
                          style={{ fontSize: 11, color: "#6366f1", background: "none", border: "none", cursor: "pointer", fontWeight: 600 }}>
                          Done
                        </button>
                      </div>
                    </div>
                  )}
                </div>
                <span style={{ fontSize: 13, color: "#64748b", fontWeight: 500 }}>{planRows.length} changes</span>
              </div>

              <div style={S.tableWrap}>
                <table style={S.table}>
                  <thead>
                    <tr>
                      {["Detected","Domain","Account","Business","CS Owner","Change","Previous Plan","New Plan"].map(label => (
                        <th key={label} style={{ ...S.th, color: "#475569" }}>{label}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {planRows.length === 0 ? (
                      <tr><td colSpan={8} style={{ textAlign: "center", padding: 48, color: "#94a3b8" }}>
                        <div style={{ fontSize: 32, marginBottom: 8 }}>📈</div>
                        <div style={{ fontWeight: 600 }}>No plan changes detected yet</div>
                        <div style={{ fontSize: 12, marginTop: 4 }}>Click &quot;Check for changes&quot; periodically — changes are detected relative to the last check.</div>
                      </td></tr>
                    ) : planRows.map((c, i) => {
                      const rowBg = i % 2 === 0 ? "#fff" : "#fafbff";
                      const typeStyle: React.CSSProperties =
                        c.change_type === "Upgrade"   ? { color: "#065f46", background: "#d1fae5", border: "1px solid #6ee7b7" } :
                        c.change_type === "Downgrade" ? { color: "#7f1d1d", background: "#fee2e2", border: "1px solid #fca5a5" } :
                        c.change_type === "Currency Switch" ? { color: "#92400e", background: "#fef3c7", border: "1px solid #fcd34d" } :
                        { color: "#374151", background: "#f3f4f6", border: "1px solid #d1d5db" };
                      return (
                        <tr key={`${c.customer_id}-${c.account}-${c.detected_at}`} style={{ background: rowBg }}>
                          <td style={{ ...S.td, fontSize: 12, color: "#475569" }}>{fmtDate(c.detected_at.split("T")[0])}</td>
                          <td style={S.td}>
                            <div style={{ fontWeight: 600, fontSize: 13, color: "#0f172a" }}>{c.domain || "—"}</div>
                            <div style={{ fontSize: 11, color: "#94a3b8" }}>{c.customer_name}</div>
                          </td>
                          <td style={S.td}><span style={acctStyle(c.account)}>{c.account}</span></td>
                          <td style={S.td}>{c.business || <span style={{ color: "#cbd5e1" }}>—</span>}</td>
                          <td style={S.td}><span style={{ fontSize: 12, color: "#475569" }}>{c.cs_email?.split("@")[0] || "—"}</span></td>
                          <td style={S.td}>
                            <span style={{ borderRadius: 20, padding: "3px 10px", fontSize: 11, fontWeight: 700, display: "inline-block", ...typeStyle }}>
                              {c.change_type === "Upgrade" ? "⬆ " : c.change_type === "Downgrade" ? "⬇ " : ""}{c.change_type}
                            </span>
                          </td>
                          <td style={{ ...S.td, fontSize: 12 }}>
                            <div style={{ color: "#475569" }}>{c.previous_plan || "—"}</div>
                            <div style={{ color: "#94a3b8" }}>{c.previous_currency} {c.previous_value.toFixed(2)}</div>
                          </td>
                          <td style={{ ...S.td, fontSize: 12 }}>
                            <div style={{ color: "#0f172a", fontWeight: 600 }}>{c.new_plan || "—"}</div>
                            <div style={{ color: "#94a3b8" }}>{c.new_currency} {c.new_value.toFixed(2)}</div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
          </>
          )}

          {planViewMode === "revenue" && (
            <>
              {ledgerLoading && (
                <div style={S.center}>
                  <div style={S.spin} />
                  <p style={{ marginTop: 16, color: "#64748b", fontSize: 14 }}>Fetching invoice history from Stripe (this may take 20–40s)...</p>
                </div>
              )}

              {ledgerError && (
                <div style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 10, padding: "16px 20px", color: "#dc2626", marginBottom: 16 }}>
                  ⚠ {ledgerError}
                </div>
              )}

              {!ledgerLoading && ledgerData && (
                <>
                  <div style={{ display: "flex", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
                    <div style={{ background: "#fff", border: "1px solid #bbf7d0", borderRadius: 10, padding: "12px 18px" }}>
                      <div style={{ fontSize: 11, color: "#16a34a", fontWeight: 700, textTransform: "uppercase" as const }}>⬆ Net Upsell (selected range)</div>
                      <div style={{ fontSize: 22, fontWeight: 800, color: "#16a34a" }}>{revenueUpgradeCount}</div>
                      <div style={{ fontSize: 12, color: "#16a34a", marginTop: 2 }}>
                        {revenueNetUpsellTotals.size === 0 ? "—" : Array.from(revenueNetUpsellTotals.entries()).map(([cur, amt]) => `+${cur} ${amt.toLocaleString("en-US", { maximumFractionDigits: 0 })}`).join(" · ")}
                      </div>
                    </div>
                    <div style={{ background: "#fff", border: "1px solid #fecaca", borderRadius: 10, padding: "12px 18px" }}>
                      <div style={{ fontSize: 11, color: "#dc2626", fontWeight: 700, textTransform: "uppercase" as const }}>⬇ Net Downgrade (selected range)</div>
                      <div style={{ fontSize: 22, fontWeight: 800, color: "#dc2626" }}>{revenueDowngradeCount}</div>
                      <div style={{ fontSize: 12, color: "#dc2626", marginTop: 2 }}>
                        {revenueNetDowngradeTotals.size === 0 ? "—" : Array.from(revenueNetDowngradeTotals.entries()).map(([cur, amt]) => `-${cur} ${amt.toLocaleString("en-US", { maximumFractionDigits: 0 })}`).join(" · ")}
                      </div>
                    </div>
                  </div>

                  <div style={{ marginBottom: 12, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", background: "#fff", padding: "12px 16px", borderRadius: 10, boxShadow: "0 1px 3px rgba(0,0,0,0.05)" }}>
                    <input
                      style={S.searchInput}
                      placeholder="🔍  Search domain, customer, business..."
                      value={planSearch}
                      onChange={e => setPlanSearch(e.target.value)}
                    />
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <label style={{ fontSize: 11, color: "#64748b", fontWeight: 700, whiteSpace: "nowrap" }}>Account</label>
                      <select style={{ ...sel, width: 100 }} value={planAcctF} onChange={e => setPlanAcctF(e.target.value)}>
                        <option value="All">All</option>
                        <option value="India">India</option>
                        <option value="US">US</option>
                      </select>
                    </div>
                    <div style={{ position: "relative" }}>
                      <label style={{ fontSize: 11, color: "#64748b", fontWeight: 700, whiteSpace: "nowrap", marginRight: 6 }}>Months to compare</label>
                      <button
                        onClick={() => setRevenueMonthPickerOpen(v => !v)}
                        style={{ ...sel, width: "auto", minWidth: 160, textAlign: "left", display: "inline-flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                        <span>
                          {revenueMonthsF.size === 0
                            ? "Select months..."
                            : Array.from(revenueMonthsF).sort().map(planMonthLabel).join(", ")}
                        </span>
                        <span style={{ fontSize: 10 }}>{revenueMonthPickerOpen ? "▲" : "▼"}</span>
                      </button>
                      {revenueMonthPickerOpen && (
                        <div style={{
                          position: "absolute", top: "100%", left: 0, marginTop: 4, zIndex: 20,
                          background: "#fff", border: "1px solid #e2e8f0", borderRadius: 8,
                          boxShadow: "0 4px 16px rgba(0,0,0,0.12)", padding: 10, minWidth: 180, maxHeight: 240, overflowY: "auto",
                        }}>
                          {revenueMonthOptions.length === 0 ? (
                            <div style={{ fontSize: 12, color: "#94a3b8", padding: "4px 6px" }}>No invoiced months found</div>
                          ) : revenueMonthOptions.map(ym => (
                            <label key={ym} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "#374151", padding: "4px 6px", cursor: "pointer", borderRadius: 5 }}>
                              <input type="checkbox" checked={revenueMonthsF.has(ym)} onChange={() => toggleRevenueMonth(ym)} />
                              {planMonthLabel(ym)}
                            </label>
                          ))}
                          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8, paddingTop: 8, borderTop: "1px solid #f1f5f9" }}>
                            <button
                              onClick={() => setRevenueMonthsF(new Set(sensibleDefaultMonths))}
                              style={{ fontSize: 11, color: "#ef4444", background: "none", border: "none", cursor: "pointer", fontWeight: 600 }}>
                              Reset to latest 2
                            </button>
                            <button
                              onClick={() => setRevenueMonthPickerOpen(false)}
                              style={{ fontSize: 11, color: "#6366f1", background: "none", border: "none", cursor: "pointer", fontWeight: 600 }}>
                              Done
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                    <span style={{ fontSize: 13, color: "#64748b", fontWeight: 500 }}>{revenueRows.length} customers</span>
                    <span style={{ fontSize: 11, color: "#94a3b8", fontStyle: "italic" }}>
                      Each month's change compares it to that customer's actual previous calendar month
                    </span>
                  </div>

                  <div style={S.tableWrap}>
                    <table style={S.table}>
                      <thead>
                        <tr>
                          {["Domain","Account","Business","CS Owner", ...Array.from(revenueMonthsF).sort().map(planMonthLabel), "Net Change (Selected Range)"].map(label => (
                            <th key={label} style={{ ...S.th, color: "#475569" }}>{label}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {revenueRows.length === 0 ? (
                          <tr><td colSpan={5 + revenueMonthsF.size} style={{ textAlign: "center", padding: 48, color: "#94a3b8" }}>
                            <div style={{ fontSize: 32, marginBottom: 8 }}>💰</div>
                            <div style={{ fontWeight: 600 }}>{revenueMonthsF.size === 0 ? "Select at least one month above" : "No customers match your filters"}</div>
                          </td></tr>
                        ) : revenueRows.map((r, i) => {
                          const rowBg = i % 2 === 0 ? "#fff" : "#fafbff";
                          const chipStyle = (t: string): React.CSSProperties =>
                            t === "Upgrade"   ? { color: "#065f46", background: "#d1fae5", border: "1px solid #6ee7b7" } :
                            t === "Downgrade" ? { color: "#7f1d1d", background: "#fee2e2", border: "1px solid #fca5a5" } :
                            t === "Currency Switch" ? { color: "#92400e", background: "#fef3c7", border: "1px solid #fcd34d" } :
                            t === "New/Reactivated"  ? { color: "#075985", background: "#e0f2fe", border: "1px solid #7dd3fc" } :
                            t === "Churned" ? { color: "#7f1d1d", background: "#fee2e2", border: "1px solid #fca5a5" } :
                            { color: "#374151", background: "#f3f4f6", border: "1px solid #d1d5db" };
                          return (
                            <tr key={r.key} style={{ background: rowBg }}>
                              <td style={S.td}>
                                <div style={{ fontWeight: 600, fontSize: 13, color: "#0f172a" }}>{r.domain || "—"}</div>
                                <div style={{ fontSize: 11, color: "#94a3b8" }}>{r.customer_name}</div>
                              </td>
                              <td style={S.td}><span style={acctStyle(r.account)}>{r.account}</span></td>
                              <td style={S.td}>{r.business || <span style={{ color: "#cbd5e1" }}>—</span>}</td>
                              <td style={S.td}><span style={{ fontSize: 12, color: "#475569" }}>{r.cs_email?.split("@")[0] || "—"}</span></td>
                              {r.monthCols.map(c => {
                                const delta = c.amount - c.prevAmount;
                                const showDelta = c.change_type !== "—" && c.change_type !== "Flat";
                                const showInvoices = (c.change_type === "Upgrade" || c.change_type === "Downgrade") && c.invoices.length > 0;
                                const payStatus = showInvoices ? paymentStatus(c.invoices) : null;
                                return (
                                  <td key={c.ym} style={{ ...S.td, fontSize: 13, fontWeight: 600, color: c.amount > 0 ? "#0f172a" : "#cbd5e1" }}>
                                    <div>{c.amount > 0 ? `${c.currency} ${c.amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "—"}</div>
                                    {showDelta && (
                                      <span style={{ marginTop: 3, borderRadius: 12, padding: "1px 7px", fontSize: 10, fontWeight: 700, display: "inline-block", whiteSpace: "nowrap", ...chipStyle(c.change_type) }}>
                                        {c.change_type === "Upgrade" ? `⬆ +${c.currency} ${Math.abs(delta).toFixed(0)}` :
                                         c.change_type === "Downgrade" ? `⬇ -${c.currency} ${Math.abs(delta).toFixed(0)}` :
                                         c.change_type}
                                      </span>
                                    )}
                                    {payStatus && (
                                      <div style={{ marginTop: 3 }}>
                                        <span style={{ borderRadius: 12, padding: "1px 7px", fontSize: 10, fontWeight: 700, display: "inline-block", whiteSpace: "nowrap", ...payStatus.style }}>
                                          {payStatus.label}
                                        </span>
                                      </div>
                                    )}
                                    {showDelta && r.cs_email && (
                                      <div style={{ marginTop: 3, fontSize: 10, color: "#6366f1", fontWeight: 600, whiteSpace: "nowrap" }}>
                                        CSM: {r.cs_email}
                                      </div>
                                    )}
                                    {c.reasons.length > 0 && (
                                      <div style={{ marginTop: 3, fontSize: 10, color: "#475569", fontWeight: 500, lineHeight: 1.6 }}>
                                        {c.reasons.map((rs, ri) => (
                                          <div key={ri} style={{ whiteSpace: "nowrap" }}>
                                            {rs.type === "New Product" ? "＋ New: " : rs.type === "Product Removed" ? "－ Dropped: " : rs.type === "Price Increase" ? "▲ Price ↑: " : "▼ Price ↓: "}
                                            {rs.name} ({rs.delta > 0 ? "+" : "-"}{c.currency} {Math.abs(rs.delta).toFixed(0)})
                                          </div>
                                        ))}
                                      </div>
                                    )}
                                    {showInvoices && (
                                      <div style={{ marginTop: 3, fontSize: 10, color: "#94a3b8", fontWeight: 400, lineHeight: 1.5 }}>
                                        {c.invoices.map(iv => (
                                          <div key={iv.invoice_number} style={{ whiteSpace: "nowrap" }}>
                                            {iv.status === "paid" ? "✓" : "○"} {iv.invoice_number} · raised {fmtDate(iv.invoice_date)}{iv.paid_at ? ` · paid ${fmtDate(iv.paid_at)}` : ` · ${iv.status}`}
                                          </div>
                                        ))}
                                      </div>
                                    )}
                                  </td>
                                );
                              })}
                              <td style={S.td}>
                                <span style={{ borderRadius: 20, padding: "3px 10px", fontSize: 11, fontWeight: 700, display: "inline-block", whiteSpace: "nowrap", ...chipStyle(r.net_change_type) }}>
                                  {r.net_change_type === "Upgrade" ? `⬆ +${r.net_last_currency} ${Math.abs(r.net_delta).toLocaleString("en-US", { maximumFractionDigits: 0 })}` :
                                   r.net_change_type === "Downgrade" ? `⬇ -${r.net_last_currency} ${Math.abs(r.net_delta).toLocaleString("en-US", { maximumFractionDigits: 0 })}` :
                                   r.net_change_type}
                                </span>
                                {r.monthCols.length >= 2 && r.net_change_type !== "—" && (
                                  <div style={{ fontSize: 10, color: "#94a3b8", marginTop: 3 }}>
                                    {planMonthLabel(r.net_first_ym ?? "")} → {planMonthLabel(r.net_last_ym ?? "")}
                                  </div>
                                )}
                                {(r.net_change_type === "Upgrade" || r.net_change_type === "Downgrade") && r.net_last_invoices.length > 0 && (() => {
                                  const netPayStatus = paymentStatus(r.net_last_invoices);
                                  return netPayStatus && (
                                    <div style={{ marginTop: 3 }}>
                                      <span style={{ borderRadius: 12, padding: "1px 7px", fontSize: 10, fontWeight: 700, display: "inline-block", whiteSpace: "nowrap", ...netPayStatus.style }}>
                                        {netPayStatus.label}
                                      </span>
                                    </div>
                                  );
                                })()}
                                {(r.net_change_type === "Upgrade" || r.net_change_type === "Downgrade") && r.cs_email && (
                                  <div style={{ marginTop: 3, fontSize: 10, color: "#6366f1", fontWeight: 600, whiteSpace: "nowrap" }}>
                                    CSM: {r.cs_email}
                                  </div>
                                )}
                                {r.net_reasons.length > 0 && (
                                  <div style={{ marginTop: 3, fontSize: 10, color: "#475569", fontWeight: 500, lineHeight: 1.6 }}>
                                    {r.net_reasons.map((rs, ri) => (
                                      <div key={ri} style={{ whiteSpace: "nowrap" }}>
                                        {rs.type === "New Product" ? "＋ New: " : rs.type === "Product Removed" ? "－ Dropped: " : rs.type === "Price Increase" ? "▲ Price ↑: " : "▼ Price ↓: "}
                                        {rs.name} ({rs.delta > 0 ? "+" : "-"}{r.net_last_currency} {Math.abs(rs.delta).toFixed(0)})
                                      </div>
                                    ))}
                                  </div>
                                )}
                                {(r.net_change_type === "Upgrade" || r.net_change_type === "Downgrade") && r.net_last_invoices.length > 0 && (
                                  <div style={{ marginTop: 3, fontSize: 10, color: "#94a3b8", lineHeight: 1.5 }}>
                                    {r.net_last_invoices.map(iv => (
                                      <div key={iv.invoice_number} style={{ whiteSpace: "nowrap" }}>
                                        {iv.status === "paid" ? "✓" : "○"} {iv.invoice_number} · raised {fmtDate(iv.invoice_date)}{iv.paid_at ? ` · paid ${fmtDate(iv.paid_at)}` : ` · ${iv.status}`}
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  <div style={{ textAlign: "center", padding: "12px 0", color: "#94a3b8", fontSize: 12 }}>
                    Revenue = full invoice amount booked to its service period&apos;s start month (e.g. Jun 23–Jul 23 counts entirely as June, no day-splitting), voided invoices excluded, <b>net of Credit Notes</b> (a fully-credited invoice counts as no sale), <b>ex-GST for India</b> (uses Stripe&apos;s tax figure when available, else assumes 18%) · a quiet month still covered by an earlier multi-month invoice shows &quot;—&quot; rather than a false Churned/Downgrade · &quot;Net Change&quot; compares the last selected month directly against the first selected month, using the last real billing state for each · Upgrade/Downgrade reasons are matched by Stripe product (falls back to line description if a line has no Price/Product attached) and use raw line amounts, not GST/Credit-Note adjusted
                  </div>
                </>
              )}
            </>
          )}
        </div>
      )}

      {/* ── All other tabs ── */}
      {activeTab !== "ledger" && activeTab !== "planChanges" && (
        <>
          {/* ── TOP STAT CARDS ── */}
          <div style={S.statsRow}>
            <div style={{ ...S.card, borderTop: "3px solid #6366f1" }}>
              <div style={S.cardLabel}>Total Outstanding</div>
              <div style={{ ...S.cardVal, color: "#4338ca" }}>{fmtUSD(grandTotal)}</div>
              <div style={S.cardSub}>{displayRows.length} customers</div>
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
                <div style={S.cardSub}>{displayRows.filter(r => bucketCount(r, b) > 0).length} customers</div>
              </div>
            ))}
          </div>

          {/* ── AGING MODE TOGGLE ── */}
          <div style={{ marginBottom: 14, display: "flex", alignItems: "center", gap: 16, background: "#fff", padding: "10px 16px", borderRadius: 10, boxShadow: "0 1px 3px rgba(0,0,0,0.05)", flexWrap: "wrap" }}>
            <AgingModeToggle />
          </div>

          {/* ── TAB QUICK FILTERS (Active / Inactive tabs) ── */}
          {(activeTab === "active" || activeTab === "inactive") && (
            <div style={{ marginBottom: 16, display: "flex", alignItems: "center", gap: 16, background: "#fff", padding: "14px 18px", borderRadius: 10, boxShadow: "0 1px 3px rgba(0,0,0,0.05)", flexWrap: "wrap" }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: "#64748b", textTransform: "uppercase" as const, letterSpacing: 0.6 }}>Filter:</span>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <label style={{ fontSize: 12, color: "#475569", fontWeight: 600, whiteSpace: "nowrap" }}>Business Type</label>
                <select style={{ ...sel, width: 160 }} value={bizF} onChange={e => setBizF(e.target.value)}>
                  <option value="All">All</option>
                  {bizTypeOptions.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <label style={{ fontSize: 12, color: "#475569", fontWeight: 600, whiteSpace: "nowrap" }}>Payment Mode</label>
                <select style={{ ...sel, width: 150 }} value={pmF} onChange={e => setPmF(e.target.value)}>
                  <option value="All">All</option>
                  <option value="auto">🤖 Auto Pay</option>
                  <option value="manual">📧 Manual</option>
                </select>
              </div>
              {(bizF !== "All" || pmF !== "All") && (
                <button onClick={() => { setBizF("All"); setPmF("All"); }}
                  style={{ fontSize: 12, color: "#ef4444", background: "#fee2e2", border: "1px solid #fca5a5", borderRadius: 20, padding: "5px 14px", cursor: "pointer", fontWeight: 600 }}>✕ Clear</button>
              )}
            </div>
          )}

          {/* ── AUTO PAY / MANUAL SUMMARY CARD ── */}
          {(activeTab === "autopay" || activeTab === "manual") && (() => {
            const failed  = displayRows.filter(r => r.total > 0);
            const healthy = displayRows.filter(r => r.total === 0);
            const isAuto  = activeTab === "autopay";
            return (
              <div style={{ marginBottom: 16, background: "#fff", borderRadius: 12, padding: "20px 24px", boxShadow: "0 1px 4px rgba(0,0,0,0.06)", border: isAuto ? "1px solid #c4b5fd" : "1px solid #fde68a" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap", marginBottom: 16 }}>
                  <div style={{ fontSize: 15, fontWeight: 800, color: "#0f172a" }}>
                    {isAuto ? "🤖 Auto Pay" : "📧 Manual Pay"} — {displayRows.length} customers
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <div style={{ display: "flex", width: 140, height: 10, borderRadius: 5, overflow: "hidden", gap: 1 }}>
                      <div style={{ flex: autoPayStats.autoPay, background: "#6366f1", minWidth: 4 }} />
                      <div style={{ flex: autoPayStats.manual,  background: "#f59e0b", minWidth: 4 }} />
                    </div>
                    <span style={{ fontSize: 12, color: "#6366f1", fontWeight: 700 }}>{autoPayStats.autoPayPct}% auto pay</span>
                    <span style={{ fontSize: 12, color: "#64748b" }}>({autoPayStats.autoPay} of {autoPayStats.total} total customers)</span>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginLeft: "auto" }}>
                    <label style={{ fontSize: 12, color: "#475569", fontWeight: 600 }}>Business</label>
                    <select style={{ ...sel, width: 150 }} value={bizF} onChange={e => setBizF(e.target.value)}>
                      <option value="All">All types</option>
                      {bizTypeOptions.map(t => <option key={t} value={t}>{t}</option>)}
                    </select>
                  </div>
                </div>
                <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 16 }}>
                  <div style={{ flex: 1, minWidth: 180, background: "#f0fdf4", borderRadius: 10, padding: "14px 18px", border: "1px solid #bbf7d0" }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: "#166534", textTransform: "uppercase" as const, letterSpacing: 0.5, marginBottom: 4 }}>
                      {isAuto ? "✓ Auto Pay Working" : "📧 Manual — Up to date"}
                    </div>
                    <div style={{ fontSize: 26, fontWeight: 800, color: "#15803d" }}>{healthy.length}</div>
                    <div style={{ fontSize: 12, color: "#166534" }}>customers · $0 outstanding</div>
                  </div>
                  {failed.length > 0 && (
                    <div
                      onClick={() => setPmTabExpanded(v => !v)}
                      style={{ flex: 1, minWidth: 180, background: "#fef2f2", borderRadius: 10, padding: "14px 18px", border: "1px solid #fecaca", cursor: "pointer" }}>
                      <div style={{ fontSize: 11, fontWeight: 700, color: "#991b1b", textTransform: "uppercase" as const, letterSpacing: 0.5, marginBottom: 4 }}>
                        {isAuto ? "⚠ Auto Pay Paused / Failed" : "⚠ Outstanding Invoices"}
                      </div>
                      <div style={{ fontSize: 26, fontWeight: 800, color: "#dc2626" }}>{failed.length}</div>
                      <div style={{ fontSize: 12, color: "#991b1b" }}>
                        customers · {fmtUSD(grandTotal)} outstanding
                      </div>
                      <div style={{ fontSize: 11, color: "#6366f1", marginTop: 6, fontWeight: 600 }}>
                        {pmTabExpanded ? "▲ Collapse list" : "▼ Click to see customer list"}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            );
          })()}

          {/* ── BUSINESS TYPE BREAKDOWN (All tab only) ── */}
          {activeTab === "all" && <div style={{ marginBottom: 20 }}>
            <div style={S.sectionLabel}>
              Business Type Breakdown
              {hasActiveFilters && <span style={{ fontWeight: 400, color: "#94a3b8", textTransform: "none", fontSize: 12, marginLeft: 6 }}>· filtered view</span>}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(250px,1fr))", gap: 12 }}>
              {bizStats.map(({ biz, total, count, dso, b0_30, b31_60, b61_90, b90_180, b180plus, autoPay, autoPayPct }) => {
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
                    {autoPay > 0 && autoPay < count && (
                      <div style={{ marginTop: 4, fontSize: 11, color: "#6366f1" }}>{autoPay}/{count} on auto pay</div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>}

          {/* ── SEARCH + FILTER BAR + TABLE ── */}
          {(activeTab !== "autopay" && activeTab !== "manual") || pmTabExpanded ? <>

          <div style={{ marginBottom: 12, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", background: "#fff", padding: "12px 16px", borderRadius: 10, boxShadow: "0 1px 3px rgba(0,0,0,0.05)" }}>
            <input style={S.searchInput} placeholder="🔍  Search customer, domain, email..." value={search} onChange={e => setSearch(e.target.value)} />
            <span style={{ color: "#64748b", fontSize: 13, fontWeight: 500 }}>{displayRows.length} customers · {fmtUSD(grandTotal)}</span>
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
            <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
              <button onClick={downloadCSV} style={{ fontSize: 12, background: "#f0fdf4", color: "#16a34a", border: "1px solid #86efac", borderRadius: 8, padding: "5px 12px", cursor: "pointer", fontWeight: 600 }}>
                ⬇ CSV (filtered)
              </button>
              <button onClick={downloadDSOCSV} style={{ fontSize: 12, background: "#eff6ff", color: "#2563eb", border: "1px solid #93c5fd", borderRadius: 8, padding: "5px 12px", cursor: "pointer", fontWeight: 600 }}>
                ⬇ CSV (all DSO)
              </button>
            </div>
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
                  <Th label={agingMode === "invoice_date" ? "0–30d (inv)" : "0–30d"}   col="b0_30"    color="#10b981" />
                  <Th label={agingMode === "invoice_date" ? "31–60d (inv)" : "31–60d"}  col="b31_60"   color="#f59e0b" />
                  <Th label={agingMode === "invoice_date" ? "61–90d (inv)" : "61–90d"}  col="b61_90"   color="#f97316" />
                  <Th label={agingMode === "invoice_date" ? "90–180d (inv)" : "90–180d"} col="b90_180"  color="#ef4444" />
                  <Th label={agingMode === "invoice_date" ? "180+d (inv)" : "180+d"}   col="b180plus" color="#7c3aed" />
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
                      <option value="<30d">&lt;30d</option>
                      <option value=">30d">&gt;30d</option>
                      <option value="0–30d">0–30d</option>
                      <option value="31–60d">31–60d</option>
                      <option value="61–90d">61–90d</option>
                      <option value=">90d">&gt;90d</option>
                    </select>
                  </FTh>
                </tr>
              </thead>
              <tbody>
                {displayRows.filter(r => r.total > 0 || activeTab === "all" || activeTab === "active" || activeTab === "inactive").length === 0
                  ? <tr><td colSpan={13} style={{ textAlign: "center", padding: 48, color: "#94a3b8" }}>
                      <div style={{ fontSize: 32, marginBottom: 8 }}>🔍</div>
                      <div style={{ fontWeight: 600, marginBottom: 4 }}>No customers match your filters</div>
                      <button onClick={resetFilters} style={{ color: "#6366f1", background: "none", border: "none", cursor: "pointer", textDecoration: "underline", fontSize: 13 }}>Clear all filters</button>
                    </td></tr>
                  : displayRows
                      .filter(r => (activeTab === "autopay" || activeTab === "manual") ? r.total > 0 : true)
                      .map((r, i) => {
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
                              {r.collection_method === "charge_automatically" && r.total > 0
                                ? <span style={{ background: "#fee2e2", color: "#dc2626", borderRadius: 20, padding: "3px 10px", fontSize: 11, fontWeight: 700, border: "1px solid #fca5a5", whiteSpace: "nowrap" }}>⚠ Paused/Failed</span>
                                : r.collection_method === "charge_automatically"
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
                              <td style={{ ...S.td, fontSize: 12 }}>
                                <div style={{ color: "#475569" }}>
                                  <span style={{ fontSize: 10, color: "#94a3b8" }}>Inv: </span>{inv.invoice_date}
                                </div>
                                <div style={{ color: "#475569", marginTop: 2 }}>
                                  <span style={{ fontSize: 10, color: "#94a3b8" }}>Due: </span>
                                  {inv.due_date ?? <span style={{ color: "#cbd5e1" }}>—</span>}
                                </div>
                              </td>
                              <td style={{ ...S.td, fontSize: 12, color: inv.days_overdue > 0 ? "#ef4444" : "#10b981", fontWeight: 700 }}>
                                {inv.days_overdue > 0 ? `${inv.days_overdue}d overdue` : "Not due"}
                              </td>
                              <td style={S.td}>
                                <span style={{ background: agingColor(inv.aging_bucket) + "22", color: agingColor(inv.aging_bucket), border: `1px solid ${agingColor(inv.aging_bucket)}55`, borderRadius: 20, padding: "2px 8px", fontSize: 11, fontWeight: 700 }}>
                                  {agingMode === "invoice_date" ? inv.aging_bucket_from_invoice : inv.aging_bucket}
                                </span>
                              </td>
                              <td style={{ ...S.td, fontWeight: 700, fontSize: 13, color: "#4338ca" }} colSpan={8}>
                                {fmtUSD(inv.amount_usd)}
                                {inv.currency !== "USD" && <span style={{ fontSize: 11, color: "#94a3b8", marginLeft: 6 }}>{inv.currency} {inv.amount_due.toLocaleString()}</span>}
                                {inv.invoice_pdf && <a href={inv.invoice_pdf} target="_blank" rel="noreferrer" download style={{ marginLeft: 12, color: "#6366f1", fontSize: 12, fontWeight: 600 }}>⬇ Download PDF</a>}
                              </td>
                            </tr>
                          ))}
                        </>
                      );
                    })}
              </tbody>
              {displayRows.length > 0 && (
                <tfoot>
                  <tr style={{ background: "#f1f5f9", fontWeight: 800 }}>
                    <td style={{ ...S.td, fontWeight: 800, color: "#0f172a" }} colSpan={5}>
                      Subtotal — {displayRows.length} customers
                      {aggregateDSO > 0 && (
                        <span style={{ marginLeft: 10, background: dsoBg(aggregateDSO), color: dsoColor(aggregateDSO), borderRadius: 20, padding: "2px 10px", fontSize: 12, fontWeight: 700, border: `1px solid ${dsoColor(aggregateDSO)}44` }}>
                          DSO {aggregateDSO}d
                        </span>
                      )}
                    </td>
                    <td style={{ ...S.td }} />
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
            Click ⟳ for live data · Click Total to expand invoices · DSO = Total Outstanding (ex-tax) ÷ (Last Invoice ex-tax ÷ 30)
            {agingMode === "invoice_date" && <span style={{ marginLeft: 8, color: "#6366f1", fontWeight: 600 }}> · Aging from invoice date</span>}
            {agingMode === "due_date"     && <span style={{ marginLeft: 8, color: "#64748b" }}> · Aging from due date (autopay uses invoice date when no due date)</span>}
          </div>

          </> : null}
        </>
      )}
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
