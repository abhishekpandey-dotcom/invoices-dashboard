"use client";
import { useEffect, useState, useMemo, useCallback } from "react";
import type { InvoiceRow, AgingBucket } from "@/lib/stripe";

interface InvoiceRowWithUsd extends InvoiceRow { amount_usd: number; }
interface CustomerDSOWithUsd {
  customer_id: string; account: "India"|"US";
  total_outstanding_usd: number; dso_days: number;
}
interface ApiResponse {
  invoices: InvoiceRowWithUsd[];
  dso: CustomerDSOWithUsd[];
  inrPerUsd: number;
}
interface CustRow {
  key: string; customer_name: string; customer_email: string;
  domain: string; customer_status: string; business: string;
  cs_email: string; account: "India"|"US";
  b0_30: number; b31_60: number; b61_90: number; b90plus: number;
  total: number; invoice_count: number; dso_days: number;
}

const fmtUSD = (n: number) => new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",maximumFractionDigits:0}).format(n);
const agingColor = (b: AgingBucket): string => ({"0-30":"#22c55e","31-60":"#f59e0b","61-90":"#f97316","90+":"#ef4444"})[b];
const BUCKETS: AgingBucket[] = ["0-30","31-60","61-90","90+"];
function statusStyle(s: string): React.CSSProperties {
  if(s==="Active")   return{color:"#15803d",background:"#dcfce7",border:"1px solid #86efac"};
  if(s==="Inactive") return{color:"#92400e",background:"#fef3c7",border:"1px solid #fcd34d"};
  if(s==="Churned")  return{color:"#991b1b",background:"#fee2e2",border:"1px solid #fca5a5"};
  return{color:"#6b7280",background:"#f3f4f6",border:"1px solid #d1d5db"};
}
const BIZ_COLORS: [string,string][] = [["#3b82f6","#eff6ff"],["#8b5cf6","#f5f3ff"],["#06b6d4","#ecfeff"],["#10b981","#f0fdf4"],["#f59e0b","#fffbeb"],["#ec4899","#fdf2f8"]];
function bizColor(text: string): [string,string] { const idx=text.split("").reduce((a,c)=>a+c.charCodeAt(0),0)%BIZ_COLORS.length; return BIZ_COLORS[idx]; }
const acctStyle = (a:string): React.CSSProperties => a==="India"
  ?{background:"#818cf822",color:"#4f46e5",padding:"2px 8px",borderRadius:4,fontSize:12,fontWeight:600}
  :{background:"#34d39922",color:"#059669",padding:"2px 8px",borderRadius:4,fontSize:12,fontWeight:600};
function dsoColor(d: number): string { if(d>90) return "#ef4444"; if(d>60) return "#f97316"; if(d>30) return "#f59e0b"; return "#22c55e"; }

export default function Dashboard() {
  const [data, setData]               = useState<ApiResponse|null>(null);
  const [loading, setLoading]         = useState(true);
  const [refreshing, setRefreshing]   = useState(false);
  const [lastUpdated, setLastUpdated] = useState<string|null>(null);
  const [error, setError]             = useState<string|null>(null);
  const [exporting, setExp]           = useState(false);
  const [sending, setSending]         = useState(false);
  const [msg, setMsg]                 = useState<string|null>(null);
  const [expanded, setExpanded]       = useState<Set<string>>(new Set());
  const [sortCol, setSortCol]         = useState<keyof CustRow>("total");
  const [sortDir, setSortDir]         = useState<"asc"|"desc">("desc");

  const [search,   setSearch]   = useState("");
  const [acctF,    setAcctF]    = useState("All");
  const [statF,    setStatF]    = useState("All");
  const [bizF,     setBizF]     = useState("All");
  const [csF,      setCsF]      = useState("All");
  const [b0_30F,   setB0_30F]   = useState("All");
  const [b31_60F,  setB31_60F]  = useState("All");
  const [b61_90F,  setB61_90F]  = useState("All");
  const [b90plusF, setB90plusF] = useState("All");
  const [dsoF,     setDsoF]     = useState("All");
  const [totalF,   setTotalF]   = useState("All");

  const loadData = useCallback((isRefresh=false) => {
    if(isRefresh) setRefreshing(true); else setLoading(true);
    setError(null);
    fetch("/api/invoices")
      .then(r=>r.json())
      .then(d=>{ if(d.error) throw new Error(d.error); setData(d); setLastUpdated(new Date().toLocaleTimeString("en-IN",{hour:"2-digit",minute:"2-digit",second:"2-digit"})); })
      .catch(e=>setError(e.message))
      .finally(()=>{ setLoading(false); setRefreshing(false); });
  },[]);
  useEffect(()=>{ loadData(false); },[loadData]);

  const allInvoices = useMemo(()=>data?.invoices??[],[data]);
  const bizTypes = useMemo(()=>Array.from(new Set(allInvoices.map(i=>i.business).filter(Boolean))).sort(),[allInvoices]);
  const csEmails = useMemo(()=>Array.from(new Set(allInvoices.map(i=>i.cs_email).filter(Boolean))).sort(),[allInvoices]);
  const statuses = useMemo(()=>Array.from(new Set(allInvoices.map(i=>i.customer_status).filter(Boolean))).sort(),[allInvoices]);

  // DSO lookup from API: key = "Account::customer_id"
  const dsoMap = useMemo(()=>{
    const m = new Map<string, number>();
    for(const d of data?.dso??[]) m.set(`${d.account}::${d.customer_id}`, d.dso_days);
    return m;
  },[data]);

  const custRows = useMemo(()=>{
    const map = new Map<string, CustRow>();
    for(const inv of allInvoices){
      if(acctF!=="All"&&inv.account!==acctF) continue;
      if(bizF!=="All"&&inv.business!==bizF) continue;
      if(csF!=="All"&&inv.cs_email!==csF) continue;
      if(statF!=="All"&&inv.customer_status!==statF) continue;
      if(search){ const q=search.toLowerCase(); if(![inv.customer_name,inv.customer_email,inv.domain,inv.business,inv.cs_email].some(v=>v?.toLowerCase().includes(q))) continue; }
      const key=`${inv.account}::${inv.customer_id}`;
      if(!map.has(key)) map.set(key,{key,customer_name:inv.customer_name,customer_email:inv.customer_email,domain:inv.domain,customer_status:inv.customer_status,business:inv.business,cs_email:inv.cs_email,account:inv.account,b0_30:0,b31_60:0,b61_90:0,b90plus:0,total:0,invoice_count:0,dso_days:0});
      const r=map.get(key)!;
      r.total+=inv.amount_usd; r.invoice_count++;
      if(inv.aging_bucket==="0-30")       r.b0_30  +=inv.amount_usd;
      else if(inv.aging_bucket==="31-60") r.b31_60 +=inv.amount_usd;
      else if(inv.aging_bucket==="61-90") r.b61_90 +=inv.amount_usd;
      else                                r.b90plus+=inv.amount_usd;
    }
    return Array.from(map.values())
      .map(r=>({ ...r, dso_days: dsoMap.get(r.key) ?? 0 }))
      .filter(r=>{
        if(b0_30F  ==="Has balance"&&r.b0_30  <=0) return false;
        if(b31_60F ==="Has balance"&&r.b31_60 <=0) return false;
        if(b61_90F ==="Has balance"&&r.b61_90 <=0) return false;
        if(b90plusF==="Has balance"&&r.b90plus<=0) return false;
        if(dsoF==="0–30d" &&!(r.dso_days<=30))                        return false;
        if(dsoF==="31–60d"&&!(r.dso_days>30&&r.dso_days<=60))         return false;
        if(dsoF==="61–90d"&&!(r.dso_days>60&&r.dso_days<=90))         return false;
        if(dsoF===">90d"  &&!(r.dso_days>90))                         return false;
        if(totalF==="<$1k"   &&!(r.total<1000))                       return false;
        if(totalF==="$1k–5k" &&!(r.total>=1000&&r.total<5000))        return false;
        if(totalF==="$5k–20k"&&!(r.total>=5000&&r.total<20000))       return false;
        if(totalF===">$20k"  &&!(r.total>=20000))                     return false;
        return true;
      })
      .sort((a,b)=>{ const av=a[sortCol],bv=b[sortCol]; const cmp=typeof av==="number"&&typeof bv==="number"?av-bv:String(av??"").localeCompare(String(bv??"")); return sortDir==="asc"?cmp:-cmp; });
  },[allInvoices,dsoMap,acctF,bizF,csF,statF,search,b0_30F,b31_60F,b61_90F,b90plusF,dsoF,totalF,sortCol,sortDir]);

  const invoicesByKey = useMemo(()=>{ const m=new Map<string,InvoiceRowWithUsd[]>(); for(const inv of allInvoices){ const k=`${inv.account}::${inv.customer_id}`; if(!m.has(k))m.set(k,[]); m.get(k)!.push(inv); } return m; },[allInvoices]);

  const grandTotal = useMemo(()=>custRows.reduce((s,r)=>s+r.total,0),[custRows]);
  const pastDueCnt = useMemo(()=>custRows.filter(r=>r.b31_60+r.b61_90+r.b90plus>0).length,[custRows]);
  const agingTot   = useMemo(()=>{ const m={"0-30":0,"31-60":0,"61-90":0,"90+":0} as Record<AgingBucket,number>; custRows.forEach(r=>{m["0-30"]+=r.b0_30;m["31-60"]+=r.b31_60;m["61-90"]+=r.b61_90;m["90+"]+=r.b90plus;}); return m; },[custRows]);
  const aiTotal    = useMemo(()=>custRows.filter(r=>r.business==="AI Agents").reduce((s,r)=>s+r.total,0),[custRows]);
  const svcTotal   = useMemo(()=>custRows.filter(r=>r.business==="Services").reduce((s,r)=>s+r.total,0),[custRows]);

  function toggleSort(k:keyof CustRow){ if(sortCol===k) setSortDir(d=>d==="asc"?"desc":"asc"); else{setSortCol(k);setSortDir("desc");} }
  function toggleExpand(key:string){ setExpanded(prev=>{const n=new Set(prev);n.has(key)?n.delete(key):n.add(key);return n;}); }
  function resetFilters(){ setSearch("");setAcctF("All");setStatF("All");setBizF("All");setCsF("All");setB0_30F("All");setB31_60F("All");setB61_90F("All");setB90plusF("All");setDsoF("All");setTotalF("All"); }
  const hasActiveFilters = !!(search||acctF!=="All"||statF!=="All"||bizF!=="All"||csF!=="All"||b0_30F!=="All"||b31_60F!=="All"||b61_90F!=="All"||b90plusF!=="All"||dsoF!=="All"||totalF!=="All");

  async function doExport(){ setExp(true);setMsg(null); try{const r=await fetch("/api/export",{method:"POST"});const j=await r.json();if(j.error)throw new Error(j.error);setMsg("✓ Exported to Sheets");}catch(e:unknown){setMsg(`Export error: ${e instanceof Error?e.message:"failed"}`);}finally{setExp(false);} }
  async function doSend(){ setSending(true);setMsg(null); try{const r=await fetch("/api/send-reminders",{method:"POST"});const j=await r.json();if(j.error)throw new Error(j.error);setMsg(`✓ Sent ${j.total_emails} emails`);}catch(e:unknown){setMsg(`Send error: ${e instanceof Error?e.message:"failed"}`);}finally{setSending(false);} }

  const sel: React.CSSProperties = {fontSize:11,border:"1px solid #d1d5db",borderRadius:4,padding:"3px 4px",background:"#fff",cursor:"pointer",width:"100%",color:"#374151"};
  const FTh = ({children}:{children?:React.ReactNode}) => <th style={{padding:"4px 16px 8px",borderBottom:"2px solid #e5e7eb",background:"#f8fafc"}}>{children}</th>;
  const Th  = ({label,col,color}:{label:string;col:keyof CustRow;color?:string}) => (
    <th onClick={()=>toggleSort(col)} style={{...S.th,color:color??"#374151",cursor:"pointer",userSelect:"none"}}>
      {label}{sortCol===col?(sortDir==="asc"?" ↑":" ↓"):""}
    </th>
  );

  if(loading) return <div style={S.center}><div style={S.spin}/><p style={{marginTop:16,color:"#6b7280"}}>Loading invoices from Stripe...</p></div>;
  if(error)   return <div style={S.center}><div style={{color:"#ef4444",fontSize:18,fontWeight:600}}>Error</div><p style={{color:"#6b7280",marginTop:8}}>{error}</p></div>;

  return(
    <div style={S.page}>
      <div style={S.header}>
        <div>
          <h1 style={{fontSize:22,fontWeight:700,color:"#fff",margin:0}}>Outstanding Invoices</h1>
          <p style={{fontSize:13,color:"#cbd5e1",margin:"4px 0 0"}}>Customer-wise · India + US · USD · 1 USD = {data?.inrPerUsd} INR{lastUpdated&&<span style={{marginLeft:10,opacity:0.8}}>· Updated {lastUpdated}</span>}</p>
        </div>
        <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
          <button onClick={()=>loadData(true)} disabled={refreshing} style={S.ghostBtn}>{refreshing?"⟳ Refreshing...":"⟳ Refresh"}</button>
          <button onClick={doSend} disabled={sending} style={S.ghostBtn}>{sending?"Sending...":"Send CS Reminders"}</button>
          <button onClick={doExport} disabled={exporting} style={S.exportBtn}>{exporting?"Exporting...":"Export to Sheets"}</button>
        </div>
      </div>

      {msg&&<div style={S.toast}>{msg}</div>}

      <div style={S.statsRow}>
        {[
          {label:"Total Outstanding",val:fmtUSD(grandTotal),sub:`${custRows.length} customers`,color:"#6366f1"},
          {label:"Past Due Customers",val:String(pastDueCnt),sub:"with overdue invoices",color:"#ef4444"},
          {label:"AI Agents",val:fmtUSD(aiTotal),sub:`${custRows.filter(r=>r.business==="AI Agents").length} customers`,color:"#3b82f6"},
          {label:"Services",val:fmtUSD(svcTotal),sub:`${custRows.filter(r=>r.business==="Services").length} customers`,color:"#8b5cf6"},
          ...BUCKETS.map(b=>({label:`${b} days`,val:fmtUSD(agingTot[b]),sub:"",color:agingColor(b)})),
        ].map(({label,val,sub,color})=>(
          <div key={label} style={{...S.card,borderLeft:`4px solid ${color}`}}>
            <div style={{fontSize:13,color:"#6b7280",marginBottom:4}}>{label}</div>
            <div style={{fontSize:22,fontWeight:700,color}}>{val}</div>
            {sub&&<div style={{fontSize:12,color:"#9ca3af",marginTop:2}}>{sub}</div>}
          </div>
        ))}
      </div>

      <div style={{marginBottom:12,display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
        <input style={S.searchInput} placeholder="🔍  Search customer, domain, email..." value={search} onChange={e=>setSearch(e.target.value)}/>
        <span style={{color:"#6b7280",fontSize:13}}>{custRows.length} customers · {fmtUSD(grandTotal)}</span>
        {hasActiveFilters&&<button onClick={resetFilters} style={{fontSize:12,color:"#ef4444",background:"#fee2e2",border:"1px solid #fca5a5",borderRadius:6,padding:"4px 10px",cursor:"pointer"}}>✕ Clear filters</button>}
      </div>

      <div style={S.tableWrap}>
        <table style={S.table}>
          <thead>
            <tr style={{background:"#f8fafc"}}>
              <Th label="Domain"      col="domain"/>
              <Th label="Account"     col="account"/>
              <Th label="Status"      col="customer_status"/>
              <Th label="Business"    col="business"/>
              <Th label="CS Owner"    col="cs_email"/>
              <Th label="0–30 days"   col="b0_30"   color="#22c55e"/>
              <Th label="31–60 days"  col="b31_60"  color="#f59e0b"/>
              <Th label="61–90 days"  col="b61_90"  color="#f97316"/>
              <Th label="90+ days"    col="b90plus" color="#ef4444"/>
              <Th label="Total (USD)" col="total"   color="#4f46e5"/>
              <Th label="DSO (days)"  col="dso_days" color="#6366f1"/>
            </tr>
            <tr style={{background:"#f8fafc"}}>
              <FTh><input style={{...sel,padding:"3px 6px"}} placeholder="Domain..." value={search} onChange={e=>setSearch(e.target.value)}/></FTh>
              <FTh><select style={sel} value={acctF} onChange={e=>setAcctF(e.target.value)}><option value="All">All</option><option value="India">India</option><option value="US">US</option></select></FTh>
              <FTh><select style={sel} value={statF} onChange={e=>setStatF(e.target.value)}><option value="All">All</option>{statuses.map(s=><option key={s} value={s}>{s}</option>)}</select></FTh>
              <FTh><select style={sel} value={bizF} onChange={e=>setBizF(e.target.value)}><option value="All">All</option>{bizTypes.map(t=><option key={t} value={t}>{t}</option>)}</select></FTh>
              <FTh><select style={sel} value={csF} onChange={e=>setCsF(e.target.value)}><option value="All">All</option>{csEmails.map(e=><option key={e} value={e}>{e}</option>)}</select></FTh>
              <FTh><select style={sel} value={b0_30F} onChange={e=>setB0_30F(e.target.value)}><option value="All">All</option><option value="Has balance">Has balance</option></select></FTh>
              <FTh><select style={sel} value={b31_60F} onChange={e=>setB31_60F(e.target.value)}><option value="All">All</option><option value="Has balance">Has balance</option></select></FTh>
              <FTh><select style={sel} value={b61_90F} onChange={e=>setB61_90F(e.target.value)}><option value="All">All</option><option value="Has balance">Has balance</option></select></FTh>
              <FTh><select style={sel} value={b90plusF} onChange={e=>setB90plusF(e.target.value)}><option value="All">All</option><option value="Has balance">Has balance</option></select></FTh>
              <FTh>
                <select style={sel} value={totalF} onChange={e=>setTotalF(e.target.value)}>
                  <option value="All">All</option>
                  <option value="<$1k">&lt; $1k</option>
                  <option value="$1k–5k">$1k – $5k</option>
                  <option value="$5k–20k">$5k – $20k</option>
                  <option value=">$20k">&gt; $20k</option>
                </select>
              </FTh>
              <FTh>
                <select style={sel} value={dsoF} onChange={e=>setDsoF(e.target.value)}>
                  <option value="All">All</option>
                  <option value="0–30d">0–30d</option>
                  <option value="31–60d">31–60d</option>
                  <option value="61–90d">61–90d</option>
                  <option value=">90d">&gt; 90d</option>
                </select>
              </FTh>
            </tr>
          </thead>
          <tbody>
            {custRows.length===0
              ?<tr><td colSpan={11} style={{textAlign:"center",padding:40,color:"#9ca3af"}}>No customers match filters. <button onClick={resetFilters} style={{color:"#6366f1",background:"none",border:"none",cursor:"pointer",textDecoration:"underline"}}>Clear all</button></td></tr>
              :custRows.map((r,i)=>{
                const isExp=expanded.has(r.key);
                const invs=(invoicesByKey.get(r.key)??[]).sort((a,b)=>b.days_overdue-a.days_overdue);
                const [bizFg,bizBg]=r.business?bizColor(r.business):["#6b7280","#f3f4f6"];
                return(
                  <>
                    <tr key={r.key} style={{background:i%2===0?"#fff":"#f9fafb"}}>
                      <td style={S.td}><div style={{fontWeight:500,fontSize:13}}>{r.domain||"--"}</div><div style={{fontSize:11,color:"#9ca3af"}}>{r.customer_name}</div></td>
                      <td style={S.td}><span style={acctStyle(r.account)}>{r.account}</span></td>
                      <td style={S.td}>{r.customer_status?<span style={{...statusStyle(r.customer_status),borderRadius:4,padding:"2px 8px",fontSize:12,fontWeight:600}}>{r.customer_status}</span>:<span style={{color:"#9ca3af",fontSize:12}}>--</span>}</td>
                      <td style={S.td}>{r.business?<span style={{background:bizBg,color:bizFg,border:`1px solid ${bizFg}33`,borderRadius:4,padding:"2px 8px",fontSize:12,fontWeight:600}}>{r.business}</span>:<span style={{color:"#9ca3af",fontSize:12}}>--</span>}</td>
                      <td style={S.td}><span style={{fontSize:12,color:"#374151"}}>{r.cs_email||"--"}</span></td>
                      <td style={{...S.td,color:"#22c55e",fontWeight:600}}>{r.b0_30>0?fmtUSD(r.b0_30):<span style={{color:"#d1d5db"}}>—</span>}</td>
                      <td style={{...S.td,color:"#f59e0b",fontWeight:600}}>{r.b31_60>0?fmtUSD(r.b31_60):<span style={{color:"#d1d5db"}}>—</span>}</td>
                      <td style={{...S.td,color:"#f97316",fontWeight:600}}>{r.b61_90>0?fmtUSD(r.b61_90):<span style={{color:"#d1d5db"}}>—</span>}</td>
                      <td style={{...S.td,color:"#ef4444",fontWeight:600}}>{r.b90plus>0?fmtUSD(r.b90plus):<span style={{color:"#d1d5db"}}>—</span>}</td>
                      <td style={{...S.td,fontWeight:700,color:"#4f46e5",cursor:"pointer",userSelect:"none"}} onClick={()=>toggleExpand(r.key)}>
                        <div style={{display:"flex",alignItems:"center",gap:6}}>
                          {fmtUSD(r.total)}
                          <span style={{fontSize:10,background:"#ede9fe",color:"#6366f1",borderRadius:3,padding:"1px 5px"}}>{isExp?"▲":"▼"} {r.invoice_count}</span>
                        </div>
                      </td>
                      <td style={{...S.td,fontWeight:700,color:dsoColor(r.dso_days)}}>
                        {r.dso_days>0?`${r.dso_days}d`:<span style={{color:"#9ca3af",fontSize:12}}>--</span>}
                      </td>
                    </tr>
                    {isExp&&invs.map(inv=>(
                      <tr key={inv.id} style={{background:"#f5f3ff"}}>
                        <td style={{...S.td,paddingLeft:24,fontSize:12}} colSpan={2}><span style={{fontFamily:"monospace",color:"#6366f1"}}>{inv.invoice_number}</span>{inv.description&&<div style={{fontSize:11,color:"#9ca3af",marginTop:2}}>{inv.description.slice(0,60)}</div>}</td>
                        <td style={{...S.td,fontSize:12,color:"#374151"}}>{inv.due_date??"No due date"}</td>
                        <td style={{...S.td,fontSize:12,color:inv.days_overdue>0?"#ef4444":"#22c55e",fontWeight:600}}>{inv.days_overdue>0?`${inv.days_overdue}d overdue`:"Not due"}</td>
                        <td style={S.td}><span style={{background:agingColor(inv.aging_bucket)+"22",color:agingColor(inv.aging_bucket),border:`1px solid ${agingColor(inv.aging_bucket)}55`,borderRadius:4,padding:"2px 8px",fontSize:11,fontWeight:600}}>{inv.aging_bucket}</span></td>
                        <td style={{...S.td,fontWeight:600,fontSize:13,color:"#4f46e5"}} colSpan={6}>{fmtUSD(inv.amount_usd)}{inv.currency!=="USD"&&<span style={{fontSize:11,color:"#9ca3af",marginLeft:6}}>{inv.currency} {inv.amount_due.toLocaleString()}</span>}{inv.invoice_url&&<a href={inv.invoice_url} target="_blank" rel="noreferrer" style={{marginLeft:12,color:"#6366f1",fontSize:12}}>View ↗</a>}</td>
                      </tr>
                    ))}
                  </>
                );
              })}
          </tbody>
          {custRows.length>0&&(
            <tfoot>
              <tr style={{background:"#f1f5f9",fontWeight:700}}>
                <td style={{...S.td,fontWeight:700}} colSpan={5}>Total ({custRows.length} customers)</td>
                <td style={{...S.td,color:"#22c55e",fontWeight:700}}>{fmtUSD(agingTot["0-30"])}</td>
                <td style={{...S.td,color:"#f59e0b",fontWeight:700}}>{fmtUSD(agingTot["31-60"])}</td>
                <td style={{...S.td,color:"#f97316",fontWeight:700}}>{fmtUSD(agingTot["61-90"])}</td>
                <td style={{...S.td,color:"#ef4444",fontWeight:700}}>{fmtUSD(agingTot["90+"])}</td>
                <td style={{...S.td,color:"#4f46e5",fontWeight:700}}>{fmtUSD(grandTotal)}</td>
                <td style={S.td}/>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      <div style={{textAlign:"center",padding:"16px 0",color:"#9ca3af",fontSize:12}}>
        Auto-refreshes every 5 min · Click ⟳ for live data · Click Total (USD) to expand invoices · DSO = Outstanding ÷ (Avg monthly revenue last 2 months ÷ 30)
      </div>
    </div>
  );
}

const S:Record<string,React.CSSProperties>={
  page:{maxWidth:1600,margin:"0 auto",padding:"24px 20px"},
  header:{display:"flex",alignItems:"center",justifyContent:"space-between",background:"linear-gradient(135deg,#4f46e5,#7c3aed)",borderRadius:12,padding:"20px 28px",marginBottom:20,flexWrap:"wrap",gap:12},
  ghostBtn:{background:"rgba(255,255,255,0.15)",color:"#fff",border:"1px solid rgba(255,255,255,0.3)",borderRadius:8,padding:"10px 16px",fontWeight:600,fontSize:14,cursor:"pointer"},
  exportBtn:{background:"#fff",color:"#4f46e5",border:"none",borderRadius:8,padding:"10px 20px",fontWeight:600,fontSize:14,cursor:"pointer"},
  toast:{background:"#f0fdf4",border:"1px solid #bbf7d0",borderRadius:8,padding:"10px 16px",marginBottom:16,fontSize:13,color:"#166534"},
  statsRow:{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(175px,1fr))",gap:12,marginBottom:20},
  card:{background:"#fff",borderRadius:10,padding:"16px 20px",boxShadow:"0 1px 3px rgba(0,0,0,0.07)"},
  searchInput:{border:"1px solid #d1d5db",borderRadius:8,padding:"8px 12px",fontSize:14,width:300,outline:"none"},
  tableWrap:{background:"#fff",borderRadius:10,boxShadow:"0 1px 3px rgba(0,0,0,0.07)",overflow:"auto"},
  table:{width:"100%",borderCollapse:"collapse",fontSize:14},
  th:{textAlign:"left",padding:"12px 16px",fontWeight:600,fontSize:13,color:"#374151",borderBottom:"2px solid #e5e7eb",whiteSpace:"nowrap",background:"#f8fafc"},
  td:{padding:"12px 16px",borderBottom:"1px solid #f3f4f6",verticalAlign:"middle"},
  center:{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",height:"100vh",gap:8},
  spin:{width:36,height:36,border:"4px solid #e5e7eb",borderTop:"4px solid #6366f1",borderRadius:"50%",animation:"spin 0.8s linear infinite"},
};
