"use client";
import { useEffect, useState, useMemo, useCallback } from "react";
import type { InvoiceRow, CustomerDSO, AgingBucket } from "@/lib/stripe";

interface InvoiceRowWithUsd extends InvoiceRow { amount_usd: number; }
interface CustomerDSOWithUsd extends CustomerDSO { total_outstanding_usd: number; }
interface ApiResponse { invoices: InvoiceRowWithUsd[]; dso: CustomerDSOWithUsd[]; inrPerUsd: number; }

interface CustRow {
  key: string; customer_name: string; customer_email: string;
  domain: string; customer_status: string; business: string;
  cs_email: string; account: "India"|"US";
  b0_30: number; b31_60: number; b61_90: number; b90plus: number; total: number; invoice_count: number;
}

const fmtUSD = (n: number) => new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",maximumFractionDigits:0}).format(n);
const agingColor = (b: AgingBucket) => ({"0-30":"#22c55e","31-60":"#f59e0b","61-90":"#f97316","90+":"#ef4444"})[b];
function statusBadge(s: string) {
  if(s==="Active") return{color:"#15803d",background:"#dcfce7",border:"1px solid #86efac"};
  if(s==="Inactive") return{color:"#92400e",background:"#fef3c7",border:"1px solid #fcd34d"};
  if(s==="Churned") return{color:"#991b1b",background:"#fee2e2",border:"1px solid #fca5a5"};
  return{color:"#6b7280",background:"#f3f4f6",border:"1px solid #d1d5db"};
}
const BIZ_COLORS: [string,string][] = [["#3b82f6","#eff6ff"],["#8b5cf6","#f5f3ff"],["#06b6d4","#ecfeff"],["#10b981","#f0fdf4"],["#f59e0b","#fffbeb"],["#ec4899","#fdf2f8"]];
function ColorBadge({text}:{text:string}) {
  if(!text) return <span style={{color:"#9ca3af",fontSize:12}}>--</span>;
  const idx=text.split("").reduce((a,c)=>a+c.charCodeAt(0),0)%BIZ_COLORS.length;
  const[fg,bg]=BIZ_COLORS[idx];
  return <span style={{background:bg,color:fg,border:`1px solid ${fg}33`,borderRadius:4,padding:"2px 8px",fontSize:12,fontWeight:600}}>{text}</span>;
}
const acctStyle=(a:string):React.CSSProperties=>a==="India"
  ?{background:"#818cf822",color:"#4f46e5",padding:"2px 8px",borderRadius:4,fontSize:12,fontWeight:600}
  :{background:"#34d39922",color:"#059669",padding:"2px 8px",borderRadius:4,fontSize:12,fontWeight:600};
const BUCKETS: AgingBucket[] = ["0-30","31-60","61-90","90+"];

export default function Dashboard() {
  const[data,setData]=useState<ApiResponse|null>(null);
  const[loading,setLoading]=useState(true);
  const[refreshing,setRefreshing]=useState(false);
  const[lastUpdated,setLastUpdated]=useState<string|null>(null);
  const[error,setError]=useState<string|null>(null);
  const[exporting,setExp]=useState(false);
  const[exportMsg,setExpMsg]=useState<string|null>(null);
  const[sending,setSending]=useState(false);
  const[sendMsg,setSendMsg]=useState<string|null>(null);
  const[tab,setTab]=useState<"customers"|"dso">("customers");
  const[acctF,setAcctF]=useState("All");
  const[bizF,setBizF]=useState("All");
  const[csF,setCsF]=useState("All");
  const[statF,setStatF]=useState("All");
  const[search,setSearch]=useState("");
  const[sortCol,setSortCol]=useState<keyof CustRow>("total");
  const[sortDir,setSortDir]=useState<"asc"|"desc">("desc");

  const loadData = useCallback((isRefresh=false) => {
    if(isRefresh) setRefreshing(true); else setLoading(true);
    setError(null);
    fetch("/api/invoices")
      .then(r=>r.json())
      .then(d=>{
        if(d.error) throw new Error(d.error);
        setData(d);
        setLastUpdated(new Date().toLocaleTimeString("en-IN",{hour:"2-digit",minute:"2-digit",second:"2-digit"}));
      })
      .catch(e=>setError(e.message))
      .finally(()=>{ setLoading(false); setRefreshing(false); });
  },[]);

  useEffect(()=>{ loadData(false); },[loadData]);

  const bizTypes=useMemo(()=>Array.from(new Set((data?.invoices??[]).map(i=>i.business).filter(Boolean))).sort(),[data]);
  const csEmails=useMemo(()=>Array.from(new Set((data?.invoices??[]).map(i=>i.cs_email).filter(Boolean))).sort(),[data]);
  const statuses=useMemo(()=>Array.from(new Set((data?.invoices??[]).map(i=>i.customer_status).filter(Boolean))).sort(),[data]);

  const custRows=useMemo(()=>{
    const map=new Map<string,CustRow>();
    for(const inv of data?.invoices??[]){
      if(acctF!=="All"&&inv.account!==acctF) continue;
      if(bizF!=="All"&&inv.business!==bizF) continue;
      if(csF!=="All"&&inv.cs_email!==csF) continue;
      if(statF!=="All"&&inv.customer_status!==statF) continue;
      if(search){const q=search.toLowerCase();if(![inv.customer_name,inv.customer_email,inv.domain,inv.business,inv.cs_email].some(v=>v?.toLowerCase().includes(q)))continue;}
      const key=`${inv.account}::${inv.customer_id}`;
      if(!map.has(key)) map.set(key,{key,customer_name:inv.customer_name,customer_email:inv.customer_email,domain:inv.domain,customer_status:inv.customer_status,business:inv.business,cs_email:inv.cs_email,account:inv.account,b0_30:0,b31_60:0,b61_90:0,b90plus:0,total:0,invoice_count:0});
      const r=map.get(key)!;
      r.total+=inv.amount_usd; r.invoice_count++;
      if(inv.aging_bucket==="0-30")r.b0_30+=inv.amount_usd;
      else if(inv.aging_bucket==="31-60")r.b31_60+=inv.amount_usd;
      else if(inv.aging_bucket==="61-90")r.b61_90+=inv.amount_usd;
      else r.b90plus+=inv.amount_usd;
    }
    return Array.from(map.values()).sort((a,b)=>{
      const av=a[sortCol],bv=b[sortCol];
      const cmp=typeof av==="number"&&typeof bv==="number"?av-bv:String(av??"").localeCompare(String(bv??""));
      return sortDir==="asc"?cmp:-cmp;
    });
  },[data,acctF,bizF,csF,statF,search,sortCol,sortDir]);

  const dsoRows=useMemo(()=>(data?.dso??[]).filter(d=>{
    if(acctF!=="All"&&d.account!==acctF)return false;
    if(bizF!=="All"&&d.business!==bizF)return false;
    if(csF!=="All"&&d.cs_email!==csF)return false;
    if(statF!=="All"&&d.customer_status!==statF)return false;
    if(search){const q=search.toLowerCase();if(![d.customer_name,d.customer_email,d.domain,d.business,d.cs_email].some(v=>v?.toLowerCase().includes(q)))return false;}
    return true;
  }),[data,acctF,bizF,csF,statF,search]);

  const grandTotal=useMemo(()=>custRows.reduce((s,r)=>s+r.total,0),[custRows]);
  const pastDueCnt=useMemo(()=>custRows.filter(r=>r.b31_60+r.b61_90+r.b90plus>0).length,[custRows]);
  const agingTot=useMemo(()=>{const m={"0-30":0,"31-60":0,"61-90":0,"90+":0} as Record<AgingBucket,number>;custRows.forEach(r=>{m["0-30"]+=r.b0_30;m["31-60"]+=r.b31_60;m["61-90"]+=r.b61_90;m["90+"]+=r.b90plus;});return m;},[custRows]);
  const aiTotal=useMemo(()=>custRows.filter(r=>r.business==="AI Agents").reduce((s,r)=>s+r.total,0),[custRows]);
  const svcTotal=useMemo(()=>custRows.filter(r=>r.business==="Services").reduce((s,r)=>s+r.total,0),[custRows]);

  function toggleSort(k:keyof CustRow){if(sortCol===k)setSortDir(d=>d==="asc"?"desc":"asc");else{setSortCol(k);setSortDir("desc");}}

  async function doExport(){
    setExp(true);setExpMsg(null);
    try{const r=await fetch("/api/export",{method:"POST"});const j=await r.json();if(j.error)throw new Error(j.error);setExpMsg(`Exported: ${j.url}`);}
    catch(e:unknown){setExpMsg(`Error: ${e instanceof Error?e.message:"Export failed"}`);}
    finally{setExp(false);}
  }

  async function doSend(){
    setSending(true);setSendMsg(null);
    try{const r=await fetch("/api/send-reminders",{method:"POST"});const j=await r.json();if(j.error)throw new Error(j.error);setSendMsg(`✓ Sent ${j.total_emails} emails`);}
    catch(e:unknown){setSendMsg(`Error: ${e instanceof Error?e.message:"Send failed"}`);}
    finally{setSending(false);}
  }

  if(loading)return <div style={S.center}><div style={S.spin}/><p style={{marginTop:16,color:"#6b7280"}}>Loading invoices from Stripe...</p></div>;
  if(error)return <div style={S.center}><div style={{color:"#ef4444",fontSize:18,fontWeight:600}}>Error</div><p style={{color:"#6b7280",marginTop:8}}>{error}</p></div>;

  const th=(label:string,col:keyof CustRow,color?:string)=>(
    <th onClick={()=>toggleSort(col)} style={{...S.th,color:color??"#374151",cursor:"pointer"}}>
      {label}{sortCol===col?(sortDir==="asc"?" ↑":" ↓"):""}
    </th>
  );

  return (
    <div style={S.page}>
      {/* Header */}
      <div style={S.header}>
        <div>
          <h1 style={{fontSize:22,fontWeight:700,color:"#fff",margin:0}}>Outstanding Invoices</h1>
          <p style={{fontSize:13,color:"#cbd5e1",marginTop:4,margin:0}}>
            Customer-wise · India + US · USD · Rate: 1 USD = {data?.inrPerUsd} INR
            {lastUpdated&&<span style={{marginLeft:10,opacity:0.8}}>· Updated {lastUpdated}</span>}
          </p>
        </div>
        <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
          <button onClick={()=>loadData(true)} disabled={refreshing} style={S.refreshBtn}>{refreshing?"⟳ Refreshing...":"⟳ Refresh"}</button>
          <button onClick={doSend} disabled={sending} style={S.ghostBtn}>{sending?"Sending...":"Send CS Reminders"}</button>
          <button onClick={doExport} disabled={exporting} style={S.exportBtn}>{exporting?"Exporting...":"Export to Sheets"}</button>
        </div>
      </div>

      {exportMsg&&<div style={S.toast}>{exportMsg}</div>}
      {sendMsg&&<div style={S.toast}>{sendMsg}</div>}

      {/* Stat cards */}
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

      {/* Filters + tab toggle */}
      <div style={S.filterBar}>
        <input style={S.searchInput} placeholder="Search customer, domain, CS email..." value={search} onChange={e=>setSearch(e.target.value)}/>
        <select style={S.sel} value={acctF} onChange={e=>setAcctF(e.target.value)}><option value="All">All Accounts</option><option value="India">India</option><option value="US">US</option></select>
        {statuses.length>0&&<select style={S.sel} value={statF} onChange={e=>setStatF(e.target.value)}><option value="All">All Statuses</option>{statuses.map(s=><option key={s} value={s}>{s}</option>)}</select>}
        {bizTypes.length>0&&<select style={S.sel} value={bizF} onChange={e=>setBizF(e.target.value)}><option value="All">All Business Types</option>{bizTypes.map(t=><option key={t} value={t}>{t}</option>)}</select>}
        {csEmails.length>0&&<select style={S.sel} value={csF} onChange={e=>setCsF(e.target.value)}><option value="All">All CS Owners</option>{csEmails.map(e=><option key={e} value={e}>{e}</option>)}</select>}
        <span style={{color:"#6b7280",fontSize:13,marginLeft:4}}>{custRows.length} customers · {fmtUSD(grandTotal)} total</span>
        <div style={{marginLeft:"auto",display:"flex",gap:4}}>
          {(["customers","dso"] as const).map(t=>(
            <button key={t} onClick={()=>setTab(t)} style={{...S.tabBtn,background:tab===t?"#6366f1":"#e5e7eb",color:tab===t?"#fff":"#374151"}}>
              {t==="customers"?"By Customer":"DSO"}
            </button>
          ))}
        </div>
      </div>

      {/* Customer-wise table */}
      {tab==="customers"&&(
        <div style={S.tableWrap}>
          <table style={S.table}>
            <thead><tr style={{background:"#f8fafc"}}>
              {th("Domain","domain")}
              {th("Account","account")}
              {th("Status","customer_status")}
              {th("Business","business")}
              {th("CS Owner","cs_email")}
              <th onClick={()=>toggleSort("b0_30")} style={{...S.th,color:"#22c55e",cursor:"pointer"}}>0–30 days{sortCol==="b0_30"?(sortDir==="asc"?" ↑":" ↓"):""}</th>
              <th onClick={()=>toggleSort("b31_60")} style={{...S.th,color:"#f59e0b",cursor:"pointer"}}>31–60 days{sortCol==="b31_60"?(sortDir==="asc"?" ↑":" ↓"):""}</th>
              <th onClick={()=>toggleSort("b61_90")} style={{...S.th,color:"#f97316",cursor:"pointer"}}>61–90 days{sortCol==="b61_90"?(sortDir==="asc"?" ↑":" ↓"):""}</th>
              <th onClick={()=>toggleSort("b90plus")} style={{...S.th,color:"#ef4444",cursor:"pointer"}}>90+ days{sortCol==="b90plus"?(sortDir==="asc"?" ↑":" ↓"):""}</th>
              <th onClick={()=>toggleSort("total")} style={{...S.th,color:"#4f46e5",cursor:"pointer"}}>Total (USD){sortCol==="total"?(sortDir==="asc"?" ↑":" ↓"):" ↓"}</th>
            </tr></thead>
            <tbody>
              {custRows.length===0
                ?<tr><td colSpan={10} style={{textAlign:"center",padding:40,color:"#9ca3af"}}>No customers match filters.</td></tr>
                :custRows.map((r,i)=>(
                  <tr key={r.key} style={{background:i%2===0?"#fff":"#f9fafb"}}>
                    <td style={S.td}><div style={{fontWeight:500,fontSize:13}}>{r.domain||"--"}</div><div style={{fontSize:11,color:"#9ca3af"}}>{r.customer_name}</div></td>
                    <td style={S.td}><span style={acctStyle(r.account)}>{r.account}</span></td>
                    <td style={S.td}>{r.customer_status?<span style={{...statusBadge(r.customer_status),borderRadius:4,padding:"2px 8px",fontSize:12,fontWeight:600}}>{r.customer_status}</span>:<span style={{color:"#9ca3af",fontSize:12}}>--</span>}</td>
                    <td style={S.td}><ColorBadge text={r.business}/></td>
                    <td style={S.td}><span style={{fontSize:12,color:"#374151"}}>{r.cs_email||"--"}</span></td>
                    <td style={{...S.td,color:"#22c55e",fontWeight:600}}>{r.b0_30>0?fmtUSD(r.b0_30):<span style={{color:"#d1d5db"}}>—</span>}</td>
                    <td style={{...S.td,color:"#f59e0b",fontWeight:600}}>{r.b31_60>0?fmtUSD(r.b31_60):<span style={{color:"#d1d5db"}}>—</span>}</td>
                    <td style={{...S.td,color:"#f97316",fontWeight:600}}>{r.b61_90>0?fmtUSD(r.b61_90):<span style={{color:"#d1d5db"}}>—</span>}</td>
                    <td style={{...S.td,color:"#ef4444",fontWeight:600}}>{r.b90plus>0?fmtUSD(r.b90plus):<span style={{color:"#d1d5db"}}>—</span>}</td>
                    <td style={{...S.td,fontWeight:700,color:"#4f46e5"}}>{fmtUSD(r.total)}<div style={{fontSize:11,color:"#9ca3af"}}>{r.invoice_count} inv</div></td>
                  </tr>
                ))}
            </tbody>
            {custRows.length>0&&(
              <tfoot><tr style={{background:"#f1f5f9",fontWeight:700}}>
                <td style={{...S.td,fontWeight:700}} colSpan={5}>Total</td>
                <td style={{...S.td,color:"#22c55e",fontWeight:700}}>{fmtUSD(agingTot["0-30"])}</td>
                <td style={{...S.td,color:"#f59e0b",fontWeight:700}}>{fmtUSD(agingTot["31-60"])}</td>
                <td style={{...S.td,color:"#f97316",fontWeight:700}}>{fmtUSD(agingTot["61-90"])}</td>
                <td style={{...S.td,color:"#ef4444",fontWeight:700}}>{fmtUSD(agingTot["90+"])}</td>
                <td style={{...S.td,color:"#4f46e5",fontWeight:700}}>{fmtUSD(grandTotal)}</td>
              </tr></tfoot>
            )}
          </table>
        </div>
      )}

      {/* DSO table */}
      {tab==="dso"&&(
        <div style={S.tableWrap}>
          <table style={S.table}>
            <thead><tr style={{background:"#f8fafc"}}>
              {["Account","Customer","Domain","Status","Business","CS Owner","Total Outstanding","DSO (Days)","Invoices"].map(h=><th key={h} style={S.th}>{h}</th>)}
            </tr></thead>
            <tbody>
              {dsoRows.length===0
                ?<tr><td colSpan={9} style={{textAlign:"center",padding:40,color:"#9ca3af"}}>No data.</td></tr>
                :dsoRows.map((d,i)=>(
                  <tr key={d.customer_id+d.account} style={{background:i%2===0?"#fff":"#f9fafb"}}>
                    <td style={S.td}><span style={acctStyle(d.account)}>{d.account}</span></td>
                    <td style={S.td}><div style={{fontWeight:500}}>{d.customer_name}</div><div style={{fontSize:12,color:"#9ca3af"}}>{d.customer_email}</div></td>
                    <td style={S.td}><span style={{fontSize:13}}>{d.domain||"--"}</span></td>
                    <td style={S.td}>{d.customer_status?<span style={{...statusBadge(d.customer_status),borderRadius:4,padding:"2px 8px",fontSize:12,fontWeight:600}}>{d.customer_status}</span>:<span style={{color:"#9ca3af",fontSize:12}}>--</span>}</td>
                    <td style={S.td}><ColorBadge text={d.business}/></td>
                    <td style={S.td}><span style={{fontSize:12}}>{d.cs_email||"--"}</span></td>
                    <td style={{...S.td,fontWeight:600}}>{fmtUSD(d.total_outstanding_usd)}</td>
                    <td style={{...S.td,fontWeight:600,color:d.dso_days>60?"#ef4444":d.dso_days>30?"#f59e0b":"#22c55e"}}>{d.dso_days}d</td>
                    <td style={S.td}>{d.invoice_count}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}

      <div style={{textAlign:"center",padding:"16px 0",color:"#9ca3af",fontSize:12}}>
        Auto-refreshes every 5 min · Click ⟳ for live data · Paid, void, draft & uncollectible excluded
      </div>
    </div>
  );
}

const S:Record<string,React.CSSProperties>={
  page:{maxWidth:1600,margin:"0 auto",padding:"24px 20px"},
  header:{display:"flex",alignItems:"center",justifyContent:"space-between",background:"linear-gradient(135deg,#4f46e5,#7c3aed)",borderRadius:12,padding:"20px 28px",marginBottom:20,flexWrap:"wrap",gap:12},
  refreshBtn:{background:"rgba(255,255,255,0.15)",color:"#fff",border:"1px solid rgba(255,255,255,0.3)",borderRadius:8,padding:"10px 16px",fontWeight:600,fontSize:14,cursor:"pointer"},
  ghostBtn:{background:"rgba(255,255,255,0.15)",color:"#fff",border:"1px solid rgba(255,255,255,0.3)",borderRadius:8,padding:"10px 16px",fontWeight:600,fontSize:14,cursor:"pointer"},
  exportBtn:{background:"#fff",color:"#4f46e5",border:"none",borderRadius:8,padding:"10px 20px",fontWeight:600,fontSize:14,cursor:"pointer"},
  toast:{background:"#f0fdf4",border:"1px solid #bbf7d0",borderRadius:8,padding:"10px 16px",marginBottom:16,fontSize:13,color:"#166534"},
  statsRow:{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(175px,1fr))",gap:12,marginBottom:20},
  card:{background:"#fff",borderRadius:10,padding:"16px 20px",boxShadow:"0 1px 3px rgba(0,0,0,0.07)"},
  filterBar:{display:"flex",alignItems:"center",gap:10,marginBottom:16,flexWrap:"wrap"},
  searchInput:{border:"1px solid #d1d5db",borderRadius:8,padding:"8px 12px",fontSize:14,width:240,outline:"none"},
  sel:{border:"1px solid #d1d5db",borderRadius:8,padding:"8px 12px",fontSize:14,background:"#fff",cursor:"pointer"},
  tabBtn:{border:"none",borderRadius:8,padding:"8px 16px",fontSize:13,fontWeight:600,cursor:"pointer"},
  tableWrap:{background:"#fff",borderRadius:10,boxShadow:"0 1px 3px rgba(0,0,0,0.07)",overflow:"auto"},
  table:{width:"100%",borderCollapse:"collapse",fontSize:14},
  th:{textAlign:"left",padding:"12px 16px",fontWeight:600,fontSize:13,color:"#374151",borderBottom:"2px solid #e5e7eb",whiteSpace:"nowrap"},
  td:{padding:"12px 16px",borderBottom:"1px solid #f3f4f6",verticalAlign:"middle"},
  center:{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",height:"100vh",gap:8},
  spin:{width:36,height:36,border:"4px solid #e5e7eb",borderTop:"4px solid #6366f1",borderRadius:"50%",animation:"spin 0.8s linear infinite"},
};
