"use client";
import { useEffect, useState, useMemo } from "react";
import type { InvoiceRow, CustomerDSO, AgingBucket } from "@/lib/stripe";
interface InvoiceRowWithUsd extends InvoiceRow { amount_usd: number; }
interface CustomerDSOWithUsd extends CustomerDSO { total_outstanding_usd: number; }
interface ApiResponse { invoices: InvoiceRowWithUsd[]; dso: CustomerDSOWithUsd[]; inrPerUsd: number; }
interface CustRow { key:string;customer_name:string;customer_email:string;domain:string;customer_status:string;business:string;cs_email:string;account:string;b0_30:number;b31_60:number;b61_90:number;b90plus:number;total:number;invoice_count:number; }
const fmtUSD=(n:number)=>new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",maximumFractionDigits:0}).format(n);
function agingColor(b:AgingBucket):string{return{"0-30":"#22c55e","31-60":"#f59e0b","61-90":"#f97316","90+":"#ef4444"}[b];}
function statusColor(s:string){if(s==="Active")return{color:"#15803d",background:"#dcfce7",border:"1px solid #86efac"};if(s==="Inactive")return{color:"#92400e",background:"#fef3c7",border:"1px solid #fcd34d"};if(s==="Churned")return{color:"#991b1b",background:"#fee2e2",border:"1px solid #fca5a5"};return{color:"#6b7280",background:"#f3f4f6",border:"1px solid #d1d5db"};}
const BUCKETS:AgingBucket[]=["0-30","31-60","61-90","90+"];
const BIZ_COLORS:[string,string][]=[["#3b82f6","#eff6ff"],["#8b5cf6","#f5f3ff"],["#06b6d4","#ecfeff"],["#10b981","#f0fdf4"],["#f59e0b","#fffbeb"],["#ec4899","#fdf2f8"]];
function ColorBadge({text}:{text:string}){if(!text)return <span style={{color:"#9ca3af",fontSize:12}}>--</span>;const idx=text.split("").reduce((a,c)=>a+c.charCodeAt(0),0)%BIZ_COLORS.length;const[fg,bg]=BIZ_COLORS[idx];return <span style={{background:bg,color:fg,border:`1px solid ${fg}33`,borderRadius:4,padding:"2px 8px",fontSize:12,fontWeight:600}}>{text}</span>;}
function StatusBadge({status}:{status:string}){if(!status)return <span style={{color:"#9ca3af",fontSize:12}}>--</span>;return <span style={{...statusColor(status),borderRadius:4,padding:"2px 8px",fontSize:12,fontWeight:600}}>{status}</span>;}
const acctStyle=(a:string):React.CSSProperties=>a==="India"?{background:"#818cf822",color:"#4f46e5",padding:"2px 8px",borderRadius:4,fontSize:12,fontWeight:600}:{background:"#34d39922",color:"#059669",padding:"2px 8px",borderRadius:4,fontSize:12,fontWeight:600};
export default function Dashboard(){
  const[data,setData]=useState<ApiResponse|null>(null);
  const[loading,setLoading]=useState(true);
  const[error,setError]=useState<string|null>(null);
  const[exporting,setExp]=useState(false);
  const[exportMsg,setExpMsg]=useState<string|null>(null);
  const[sending,setSending]=useState(false);
  const[sendMsg,setSendMsg]=useState<string|null>(null);
  const[acctF,setAcctF]=useState("All");
  const[bizF,setBizF]=useState("All");
  const[csF,setCsF]=useState("All");
  const[statF,setStatF]=useState("All");
  const[search,setSearch]=useState("");
  const[sortCol,setSortCol]=useState<keyof CustRow>("total");
  const[sortDir,setSortDir]=useState<"asc"|"desc">("desc");
  useEffect(()=>{fetch("/api/invoices").then(r=>r.json()).then(d=>{if(d.error)throw new Error(d.error);setData(d);}).catch(e=>setError(e.message)).finally(()=>setLoading(false));},[]);
  const bizTypes=useMemo(()=>Array.from(new Set((data?.invoices??[]).map(i=>i.business).filter(Boolean))).sort(),[data]);
  const csEmails=useMemo(()=>Array.from(new Set((data?.invoices??[]).map(i=>i.cs_email).filter(Boolean))).sort(),[data]);
  const statuses=useMemo(()=>Array.from(new Set((data?.invoices??[]).map(i=>i.customer_status).filter(Boolean))).sort(),[data]);
  const customers=useMemo(()=>{
    if(!data)return[];
    const map=new Map<string,CustRow>();
    for(const inv of data.invoices){
      const key=inv.customer_id+"::"+inv.account;
      if(!map.has(key))map.set(key,{key,customer_name:inv.customer_name,customer_email:inv.customer_email,domain:inv.domain,customer_status:inv.customer_status,business:inv.business,cs_email:inv.cs_email,account:inv.account,b0_30:0,b31_60:0,b61_90:0,b90plus:0,total:0,invoice_count:0});
      const c=map.get(key)!;c.total+=inv.amount_usd;c.invoice_count++;
      if(inv.aging_bucket==="0-30")c.b0_30+=inv.amount_usd;else if(inv.aging_bucket==="31-60")c.b31_60+=inv.amount_usd;else if(inv.aging_bucket==="61-90")c.b61_90+=inv.amount_usd;else c.b90plus+=inv.amount_usd;
    }
    return Array.from(map.values()).filter(c=>{
      if(acctF!=="All"&&c.account!==acctF)return false;
      if(bizF!=="All"&&c.business!==bizF)return false;
      if(csF!=="All"&&c.cs_email!==csF)return false;
      if(statF!=="All"&&c.customer_status!==statF)return false;
      if(search){const q=search.toLowerCase();if(![c.customer_name,c.customer_email,c.domain,c.business,c.cs_email].some(v=>v?.toLowerCase().includes(q)))return false;}
      return true;
    }).sort((a,b)=>{const av=a[sortCol],bv=b[sortCol];const cmp=typeof av==="number"&&typeof bv==="number"?av-bv:String(av??"").localeCompare(String(bv??"")); return sortDir==="asc"?cmp:-cmp;});
  },[data,acctF,bizF,csF,statF,search,sortCol,sortDir]);
  const totalUsd=useMemo(()=>customers.reduce((s,c)=>s+c.total,0),[customers]);
  const pastDueCnt=useMemo(()=>customers.filter(c=>c.b31_60+c.b61_90+c.b90plus>0).length,[customers]);
  const aiTotal=useMemo(()=>customers.filter(c=>c.business==="AI Agents").reduce((s,c)=>s+c.total,0),[customers]);
  const svcTotal=useMemo(()=>customers.filter(c=>c.business==="Services").reduce((s,c)=>s+c.total,0),[customers]);
  const agingTot=useMemo(()=>({b0_30:customers.reduce((s,c)=>s+c.b0_30,0),b31_60:customers.reduce((s,c)=>s+c.b31_60,0),b61_90:customers.reduce((s,c)=>s+c.b61_90,0),b90plus:customers.reduce((s,c)=>s+c.b90plus,0)}),[customers]);
  function toggleSort(k:keyof CustRow){if(sortCol===k)setSortDir(d=>d==="asc"?"desc":"asc");else{setSortCol(k);setSortDir("desc");}}
  async function doExport(){setExp(true);setExpMsg(null);try{const r=await fetch("/api/export",{method:"POST"});const j=await r.json();if(j.error)throw new Error(j.error);setExpMsg("Exported to Google Sheets");}catch(e:unknown){setExpMsg(`Error: ${e instanceof Error?e.message:"failed"}`);}finally{setExp(false);}}
  async function doSendReminders(){setSending(true);setSendMsg(null);try{const r=await fetch("/api/send-reminders",{method:"POST"});const j=await r.json();if(j.error)throw new Error(j.error);setSendMsg(`Sent ${j.total_emails} emails to CS owners`);}catch(e:unknown){setSendMsg(`Error: ${e instanceof Error?e.message:"failed"}`);}finally{setSending(false);}}
  if(loading)return <div style={S.center}><div style={S.spin}/><p style={{marginTop:16,color:"#6b7280"}}>Loading invoices from Stripe...</p></div>;
  if(error)return <div style={S.center}><div style={{color:"#ef4444",fontSize:18,fontWeight:600}}>Error</div><p style={{marginTop:8,color:"#6b7280"}}>{error}</p></div>;
  return(
    <div style={S.page}>
      <div style={S.header}>
        <div><h1 style={{fontSize:22,fontWeight:700,color:"#fff"}}>Outstanding Invoices</h1><p style={{fontSize:13,color:"#cbd5e1",marginTop:2}}>Customer-wise · India + US · USD · Rate: 1 USD = {data?.inrPerUsd?.toFixed(1)} INR</p></div>
        <div style={{display:"flex",gap:10}}>
          <button onClick={doSendReminders} disabled={sending} style={{...S.exportBtn,background:"#818cf8",color:"#fff"}}>{sending?"Sending...":"Send CS Reminders"}</button>
          <button onClick={doExport} disabled={exporting} style={S.exportBtn}>{exporting?"Exporting...":"Export to Sheets"}</button>
        </div>
      </div>
      {exportMsg&&<div style={S.msg}>{exportMsg}</div>}
      {sendMsg&&<div style={{...S.msg,background:"#eff6ff",border:"1px solid #bfdbfe",color:"#1e40af"}}>{sendMsg}</div>}
      <div style={S.statsRow}>
        <div style={{...S.card,borderLeft:"4px solid #6366f1"}}><div style={{fontSize:13,color:"#6b7280",marginBottom:4}}>Total Outstanding</div><div style={{fontSize:22,fontWeight:700,color:"#6366f1"}}>{fmtUSD(totalUsd)}</div><div style={{fontSize:12,color:"#9ca3af",marginTop:2}}>{customers.length} customers</div></div>
        <div style={{...S.card,borderLeft:"4px solid #ef4444"}}><div style={{fontSize:13,color:"#6b7280",marginBottom:4}}>Past Due Customers</div><div style={{fontSize:22,fontWeight:700,color:"#ef4444"}}>{pastDueCnt}</div></div>
        <div style={{...S.card,borderLeft:"4px solid #3b82f6"}}><div style={{fontSize:13,color:"#6b7280",marginBottom:4}}>AI Agents</div><div style={{fontSize:22,fontWeight:700,color:"#3b82f6"}}>{fmtUSD(aiTotal)}</div><div style={{fontSize:12,color:"#9ca3af",marginTop:2}}>{customers.filter(c=>c.business==="AI Agents").length} customers</div></div>
        <div style={{...S.card,borderLeft:"4px solid #8b5cf6"}}><div style={{fontSize:13,color:"#6b7280",marginBottom:4}}>Services</div><div style={{fontSize:22,fontWeight:700,color:"#8b5cf6"}}>{fmtUSD(svcTotal)}</div><div style={{fontSize:12,color:"#9ca3af",marginTop:2}}>{customers.filter(c=>c.business==="Services").length} customers</div></div>
        <div style={{...S.card,borderLeft:"4px solid #22c55e"}}><div style={{fontSize:13,color:"#6b7280",marginBottom:4}}>0–30 days</div><div style={{fontSize:22,fontWeight:700,color:"#22c55e"}}>{fmtUSD(agingTot.b0_30)}</div></div>
        <div style={{...S.card,borderLeft:"4px solid #f59e0b"}}><div style={{fontSize:13,color:"#6b7280",marginBottom:4}}>31–60 days</div><div style={{fontSize:22,fontWeight:700,color:"#f59e0b"}}>{fmtUSD(agingTot.b31_60)}</div></div>
        <div style={{...S.card,borderLeft:"4px solid #f97316"}}><div style={{fontSize:13,color:"#6b7280",marginBottom:4}}>61–90 days</div><div style={{fontSize:22,fontWeight:700,color:"#f97316"}}>{fmtUSD(agingTot.b61_90)}</div></div>
        <div style={{...S.card,borderLeft:"4px solid #ef4444"}}><div style={{fontSize:13,color:"#6b7280",marginBottom:4}}>90+ days</div><div style={{fontSize:22,fontWeight:700,color:"#ef4444"}}>{fmtUSD(agingTot.b90plus)}</div></div>
      </div>
      <div style={S.filterBar}>
        <input style={S.searchInput} placeholder="Search customer, domain, CS email..." value={search} onChange={e=>setSearch(e.target.value)}/>
        <select style={S.sel} value={acctF} onChange={e=>setAcctF(e.target.value)}><option value="All">All Accounts</option><option value="India">India</option><option value="US">US</option></select>
        {statuses.length>0&&<select style={S.sel} value={statF} onChange={e=>setStatF(e.target.value)}><option value="All">All Statuses</option>{statuses.map(s=><option key={s} value={s}>{s}</option>)}</select>}
        {bizTypes.length>0&&<select style={S.sel} value={bizF} onChange={e=>setBizF(e.target.value)}><option value="All">All Business Types</option>{bizTypes.map(t=><option key={t} value={t}>{t}</option>)}</select>}
        {csEmails.length>0&&<select style={S.sel} value={csF} onChange={e=>setCsF(e.target.value)}><option value="All">All CS Owners</option>{csEmails.map(e=><option key={e} value={e}>{e}</option>)}</select>}
        <div style={{marginLeft:"auto",color:"#6b7280",fontSize:13}}>{customers.length} customers · {fmtUSD(totalUsd)} total</div>
      </div>
      <div style={S.tableWrap}>
        <table style={S.table}>
          <thead><tr style={{background:"#f8fafc"}}>
            {([["customer_name","Customer"],["domain","Domain"],["account","Account"],["customer_status","Status"],["business","Business"],["cs_email","CS Owner"],["b0_30","0–30 days"],["b31_60","31–60 days"],["b61_90","61–90 days"],["b90plus","90+ days"],["total","Total (USD)"]] as [keyof CustRow,string][]).map(([k,l])=>(
              <th key={k} onClick={()=>toggleSort(k)} style={{...S.th,color:k==="b0_30"?"#22c55e":k==="b31_60"?"#f59e0b":k==="b61_90"?"#f97316":k==="b90plus"?"#ef4444":k==="total"?"#4f46e5":"#374151"}}>{l}{sortCol===k?(sortDir==="asc"?" ↑":" ↓"):""}</th>
            ))}
          </tr></thead>
          <tbody>
            {customers.length===0
              ?<tr><td colSpan={11} style={{textAlign:"center",padding:40,color:"#9ca3af"}}>No customers match the selected filters.</td></tr>
              :customers.map((c,i)=>(
                <tr key={c.key} style={{background:i%2===0?"#fff":"#f9fafb"}}>
                  <td style={S.td}><div style={{fontWeight:500}}>{c.customer_name}</div><div style={{fontSize:11,color:"#9ca3af"}}>{c.customer_email}</div></td>
                  <td style={S.td}><span style={{fontSize:13}}>{c.domain||"--"}</span></td>
                  <td style={S.td}><span style={acctStyle(c.account)}>{c.account}</span></td>
                  <td style={S.td}><StatusBadge status={c.customer_status}/></td>
                  <td style={S.td}><ColorBadge text={c.business}/></td>
                  <td style={S.td}><span style={{fontSize:12,color:"#374151"}}>{c.cs_email||"--"}</span></td>
                  <td style={S.td}><span style={{fontWeight:600,color:c.b0_30>0?"#22c55e":"#d1d5db"}}>{c.b0_30>0?fmtUSD(c.b0_30):"—"}</span></td>
                  <td style={S.td}><span style={{fontWeight:600,color:c.b31_60>0?"#f59e0b":"#d1d5db"}}>{c.b31_60>0?fmtUSD(c.b31_60):"—"}</span></td>
                  <td style={S.td}><span style={{fontWeight:600,color:c.b61_90>0?"#f97316":"#d1d5db"}}>{c.b61_90>0?fmtUSD(c.b61_90):"—"}</span></td>
                  <td style={S.td}><span style={{fontWeight:600,color:c.b90plus>0?"#ef4444":"#d1d5db"}}>{c.b90plus>0?fmtUSD(c.b90plus):"—"}</span></td>
                  <td style={{...S.td,fontWeight:700,color:"#4f46e5"}}>{fmtUSD(c.total)}</td>
                </tr>
              ))}
          </tbody>
          <tfoot><tr style={{background:"#f8fafc"}}>
            <td colSpan={6} style={{padding:"12px 16px",fontWeight:700,color:"#374151"}}>Total</td>
            <td style={{padding:"12px 16px",fontWeight:700,color:"#22c55e"}}>{fmtUSD(agingTot.b0_30)}</td>
            <td style={{padding:"12px 16px",fontWeight:700,color:"#f59e0b"}}>{fmtUSD(agingTot.b31_60)}</td>
            <td style={{padding:"12px 16px",fontWeight:700,color:"#f97316"}}>{fmtUSD(agingTot.b61_90)}</td>
            <td style={{padding:"12px 16px",fontWeight:700,color:"#ef4444"}}>{fmtUSD(agingTot.b90plus)}</td>
            <td style={{padding:"12px 16px",fontWeight:700,color:"#4f46e5",fontSize:16}}>{fmtUSD(totalUsd)}</td>
          </tr></tfoot>
        </table>
      </div>
      <div style={{textAlign:"center",padding:"16px 0",color:"#9ca3af",fontSize:12}}>Refreshes every 5 min · Paid, void, draft and uncollectible excluded · Exchange rate updates hourly</div>
    </div>
  );
}
const S:Record<string,React.CSSProperties>={
  page:{maxWidth:1600,margin:"0 auto",padding:"24px 20px"},
  header:{display:"flex",alignItems:"center",justifyContent:"space-between",background:"linear-gradient(135deg,#4f46e5,#7c3aed)",borderRadius:12,padding:"20px 28px",marginBottom:20},
  exportBtn:{background:"#fff",color:"#4f46e5",border:"none",borderRadius:8,padding:"10px 20px",fontWeight:600,fontSize:14,cursor:"pointer",whiteSpace:"nowrap"},
  msg:{background:"#f0fdf4",border:"1px solid #bbf7d0",borderRadius:8,padding:"10px 16px",marginBottom:16,fontSize:13,color:"#166534"},
  statsRow:{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(165px,1fr))",gap:12,marginBottom:20},
  card:{background:"#fff",borderRadius:10,padding:"16px 20px",boxShadow:"0 1px 3px rgba(0,0,0,0.07)"},
  filterBar:{display:"flex",alignItems:"center",gap:10,marginBottom:16,flexWrap:"wrap"},
  searchInput:{border:"1px solid #d1d5db",borderRadius:8,padding:"8px 12px",fontSize:14,width:260,outline:"none"},
  sel:{border:"1px solid #d1d5db",borderRadius:8,padding:"8px 12px",fontSize:14,background:"#fff",cursor:"pointer"},
  tableWrap:{background:"#fff",borderRadius:10,boxShadow:"0 1px 3px rgba(0,0,0,0.07)",overflow:"auto"},
  table:{width:"100%",borderCollapse:"collapse",fontSize:14},
  th:{textAlign:"left",padding:"12px 16px",fontWeight:600,fontSize:13,cursor:"pointer",userSelect:"none",borderBottom:"2px solid #e5e7eb",whiteSpace:"nowrap"},
  td:{padding:"12px 16px",borderBottom:"1px solid #f3f4f6",verticalAlign:"middle"},
  center:{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",height:"100vh",gap:8},
  spin:{width:36,height:36,border:"4px solid #e5e7eb",borderTop:"4px solid #6366f1",borderRadius:"50%",animation:"spin 0.8s linear infinite"},
};
