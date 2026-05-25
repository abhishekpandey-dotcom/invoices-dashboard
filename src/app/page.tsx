"use client";
import { useEffect, useState, useMemo } from "react";
import type { InvoiceRow, CustomerDSO, AgingBucket } from "@/lib/stripe";
interface ApiResponse { invoices: InvoiceRow[]; dso: CustomerDSO[]; }
function fmtCurrency(amount: number, currency: string) { return new Intl.NumberFormat("en-IN",{style:"currency",currency,maximumFractionDigits:0}).format(amount); }
function agingColor(b: AgingBucket): string { return {"0-30":"#22c55e","31-60":"#f59e0b","61-90":"#f97316","90+":"#ef4444"}[b]; }
function statusColor(s: string) { if(s==="Active") return{color:"#15803d",background:"#dcfce7",border:"1px solid #86efac"}; if(s==="Inactive") return{color:"#92400e",background:"#fef3c7",border:"1px solid #fcd34d"}; if(s==="Churned") return{color:"#991b1b",background:"#fee2e2",border:"1px solid #fca5a5"}; return{color:"#6b7280",background:"#f3f4f6",border:"1px solid #d1d5db"}; }
const BUCKETS: AgingBucket[] = ["0-30","31-60","61-90","90+"];
const BIZ_COLORS: [string,string][] = [["#3b82f6","#eff6ff"],["#8b5cf6","#f5f3ff"],["#06b6d4","#ecfeff"],["#10b981","#f0fdf4"],["#f59e0b","#fffbeb"],["#ec4899","#fdf2f8"]];
function ColorBadge({text}:{text:string}) { if(!text) return <span style={{color:"#9ca3af",fontSize:12}}>--</span>; const idx=text.split("").reduce((a,c)=>a+c.charCodeAt(0),0)%BIZ_COLORS.length; const[fg,bg]=BIZ_COLORS[idx]; return <span style={{background:bg,color:fg,border:`1px solid ${fg}33`,borderRadius:4,padding:"2px 8px",fontSize:12,fontWeight:600}}>{text}</span>; }
function AgeBadge({bucket}:{bucket:AgingBucket}) { const color=agingColor(bucket); return <span style={{background:color+"22",color,border:`1px solid ${color}55`,borderRadius:4,padding:"2px 8px",fontSize:12,fontWeight:600}}>{bucket} days</span>; }
function StatusBadge({status}:{status:string}) { if(!status) return <span style={{color:"#9ca3af",fontSize:12}}>--</span>; return <span style={{...statusColor(status),borderRadius:4,padding:"2px 8px",fontSize:12,fontWeight:600}}>{status}</span>; }
const acctStyle=(a:string):React.CSSProperties=>a==="India"?{background:"#818cf822",color:"#4f46e5",padding:"2px 8px",borderRadius:4,fontSize:12,fontWeight:600}:{background:"#34d39922",color:"#059669",padding:"2px 8px",borderRadius:4,fontSize:12,fontWeight:600};
export default function Dashboard() {
  const[data,setData]=useState<ApiResponse|null>(null); const[loading,setLoading]=useState(true); const[error,setError]=useState<string|null>(null);
  const[exporting,setExp]=useState(false); const[exportMsg,setExpMsg]=useState<string|null>(null);
  const[acctF,setAcctF]=useState("All"); const[buckF,setBuckF]=useState("All"); const[bizF,setBizF]=useState("All");
  const[csF,setCsF]=useState("All"); const[statF,setStatF]=useState("All"); const[search,setSearch]=useState("");
  const[tab,setTab]=useState<"invoices"|"dso">("invoices"); const[sortKey,setSortKey]=useState<keyof InvoiceRow>("days_overdue"); const[sortDir,setSortDir]=useState<"asc"|"desc">("desc");
  useEffect(()=>{fetch("/api/invoices").then(r=>r.json()).then(d=>{if(d.error)throw new Error(d.error);setData(d);}).catch(e=>setError(e.message)).finally(()=>setLoading(false));},[]);
  const bizTypes=useMemo(()=>[...new Set((data?.invoices??[]).map(i=>i.business).filter(Boolean))].sort(),[data]);
  const csEmails=useMemo(()=>[...new Set((data?.invoices??[]).map(i=>i.cs_email).filter(Boolean))].sort(),[data]);
  const statuses=useMemo(()=>[...new Set((data?.invoices??[]).map(i=>i.customer_status).filter(Boolean))].sort(),[data]);
  const match=(inv:InvoiceRow)=>{
    if(acctF!=="All"&&inv.account!==acctF)return false; if(buckF!=="All"&&inv.aging_bucket!==buckF)return false;
    if(bizF!=="All"&&inv.business!==bizF)return false; if(csF!=="All"&&inv.cs_email!==csF)return false;
    if(statF!=="All"&&inv.customer_status!==statF)return false;
    if(search){const q=search.toLowerCase();if(![inv.customer_name,inv.customer_email,inv.invoice_number,inv.domain,inv.business,inv.cs_email].some(v=>v?.toLowerCase().includes(q)))return false;}
    return true;
  };
  const invoices=useMemo(()=>(data?.invoices??[]).filter(match).sort((a,b)=>{const av=a[sortKey],bv=b[sortKey];const cmp=typeof av==="number"&&typeof bv==="number"?av-bv:String(av??"").localeCompare(String(bv??"")); return sortDir==="asc"?cmp:-cmp;}),[data,acctF,buckF,bizF,csF,statF,search,sortKey,sortDir]);
  const dso=useMemo(()=>(data?.dso??[]).filter(d=>{if(acctF!=="All"&&d.account!==acctF)return false;if(bizF!=="All"&&d.business!==bizF)return false;if(csF!=="All"&&d.cs_email!==csF)return false;if(statF!=="All"&&d.customer_status!==statF)return false;if(search){const q=search.toLowerCase();if(![d.customer_name,d.customer_email,d.domain,d.business,d.cs_email].some(v=>v?.toLowerCase().includes(q)))return false;}return true;}),[data,acctF,bizF,csF,statF,search]);
  const totalAmt=useMemo(()=>invoices.reduce((s,i)=>s+i.amount_due,0),[invoices]);
  const pastDueCnt=useMemo(()=>invoices.filter(i=>i.days_overdue>0).length,[invoices]);
  const agingTot=useMemo(()=>{const m={"0-30":0,"31-60":0,"61-90":0,"90+":0} as Record<AgingBucket,number>;invoices.forEach(i=>m[i.aging_bucket]+=i.amount_due);return m;},[invoices]);
  function toggleSort(k:keyof InvoiceRow){if(sortKey===k)setSortDir(d=>d==="asc"?"desc":"asc");else{setSortKey(k);setSortDir("desc");}}
  async function doExport(){setExp(true);setExpMsg(null);try{const r=await fetch("/api/export",{method:"POST"});const j=await r.json();if(j.error)throw new Error(j.error);setExpMsg(`Exported: ${j.url}`);}catch(e:unknown){setExpMsg(`Error: ${e instanceof Error?e.message:"Export failed"}`);}finally{setExp(false);}}
  if(loading)return <div style={S.center}><div style={S.spin}/><p style={{marginTop:16,color:"#6b7280"}}>Loading invoices from Stripe...</p></div>;
  if(error)return <div style={S.center}><div style={{color:"#ef4444",fontSize:18,fontWeight:600}}>Error</div><p style={{marginTop:8,color:"#6b7280"}}>{error}</p></div>;
  const currency=invoices[0]?.currency??"USD";
  return(
    <div style={S.page}>
      <div style={S.header}>
        <div><h1 style={{fontSize:22,fontWeight:700,color:"#fff"}}>Outstanding Invoices</h1><p style={{fontSize:13,color:"#cbd5e1",marginTop:2}}>India and US Stripe accounts - Open and past-due - Linked to Customer Domain Name sheet</p></div>
        <button onClick={doExport} disabled={exporting} style={S.exportBtn}>{exporting?"Exporting...":"Export to Google Sheets"}</button>
      </div>
      {exportMsg&&<div style={S.exportMsg}>{exportMsg}</div>}
      <div style={S.statsRow}>
        {[{label:"Total Outstanding",value:fmtCurrency(totalAmt,currency),sub:`${invoices.length} invoices`,color:"#6366f1"},{label:"Past Due",value:String(pastDueCnt),sub:"invoices overdue",color:"#ef4444"},...BUCKETS.map(b=>({label:`${b} days`,value:fmtCurrency(agingTot[b],currency),color:agingColor(b),sub:""}))].map(({label,value,sub,color})=>(
          <div key={label} style={S.card}><div style={{fontSize:13,color:"#6b7280",marginBottom:4}}>{label}</div><div style={{fontSize:22,fontWeight:700,color}}>{value}</div>{sub&&<div style={{fontSize:12,color:"#9ca3af",marginTop:2}}>{sub}</div>}</div>
        ))}
      </div>
      <div style={S.filterBar}>
        <input style={S.searchInput} placeholder="Search customer, domain, CS email..." value={search} onChange={e=>setSearch(e.target.value)}/>
        <select style={S.sel} value={acctF} onChange={e=>setAcctF(e.target.value)}><option value="All">All Accounts</option><option value="India">India</option><option value="US">US</option></select>
        <select style={S.sel} value={buckF} onChange={e=>setBuckF(e.target.value)}><option value="All">All Aging</option>{BUCKETS.map(b=><option key={b} value={b}>{b} days</option>)}</select>
        {statuses.length>0&&<select style={S.sel} value={statF} onChange={e=>setStatF(e.target.value)}><option value="All">All Statuses</option>{statuses.map(s=><option key={s} value={s}>{s}</option>)}</select>}
        {bizTypes.length>0&&<select style={S.sel} value={bizF} onChange={e=>setBizF(e.target.value)}><option value="All">All Business Types</option>{bizTypes.map(t=><option key={t} value={t}>{t}</option>)}</select>}
        {csEmails.length>0&&<select style={S.sel} value={csF} onChange={e=>setCsF(e.target.value)}><option value="All">All CS Owners</option>{csEmails.map(e=><option key={e} value={e}>{e}</option>)}</select>}
        <div style={{marginLeft:"auto",display:"flex",gap:4}}>
          {(["invoices","dso"] as const).map(t=><button key={t} onClick={()=>setTab(t)} style={{...S.tabBtn,background:tab===t?"#6366f1":"#e5e7eb",color:tab===t?"#fff":"#374151"}}>{t==="invoices"?"Invoices":"DSO by Customer"}</button>)}
        </div>
      </div>
      <div style={S.tableWrap}>
        {tab==="invoices"?(
          <table style={S.table}>
            <thead><tr style={{background:"#f8fafc"}}>
              {([["account","Account"],["invoice_number","Invoice #"],["customer_name","Customer"],["domain","Domain"],["customer_status","Status"],["business","Business"],["cs_email","CS Owner"],["amount_due","Amount Due"],["due_date","Due Date"],["days_overdue","Days Overdue"],["aging_bucket","Aging"]] as [keyof InvoiceRow,string][]).map(([k,l])=>(
                <th key={k} onClick={()=>toggleSort(k)} style={S.th}>{l}{sortKey===k?(sortDir==="asc"?" up":" down"):""}</th>
              ))}
              <th style={S.th}>Invoice</th>
            </tr></thead>
            <tbody>
              {invoices.length===0?<tr><td colSpan={12} style={{textAlign:"center",padding:40,color:"#9ca3af"}}>No invoices match the selected filters.</td></tr>
              :invoices.map((inv,i)=>(
                <tr key={inv.id} style={{background:i%2===0?"#fff":"#f9fafb"}}>
                  <td style={S.td}><span style={acctStyle(inv.account)}>{inv.account}</span></td>
                  <td style={S.td}><span style={{fontFamily:"monospace",fontSize:12}}>{inv.invoice_number}</span></td>
                  <td style={S.td}><div style={{fontWeight:500}}>{inv.customer_name}</div><div style={{fontSize:12,color:"#9ca3af"}}>{inv.customer_email}</div></td>
                  <td style={S.td}><span style={{fontSize:13}}>{inv.domain||"--"}</span></td>
                  <td style={S.td}><StatusBadge status={inv.customer_status}/></td>
                  <td style={S.td}><ColorBadge text={inv.business}/></td>
                  <td style={S.td}><span style={{fontSize:12,color:"#374151"}}>{inv.cs_email||"--"}</span></td>
                  <td style={{...S.td,fontWeight:600}}>{fmtCurrency(inv.amount_due,inv.currency)}</td>
                  <td style={S.td}>{inv.due_date??"--"}</td>
                  <td style={{...S.td,color:inv.days_overdue>0?"#ef4444":"#22c55e",fontWeight:600}}>{inv.days_overdue>0?`${inv.days_overdue}d`:"Not due"}</td>
                  <td style={S.td}><AgeBadge bucket={inv.aging_bucket}/></td>
                  <td style={S.td}>{inv.invoice_url?<a href={inv.invoice_url} target="_blank" rel="noreferrer" style={{color:"#6366f1",fontSize:13}}>View</a>:"--"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ):(
          <table style={S.table}>
            <thead><tr style={{background:"#f8fafc"}}>{["Account","Customer","Domain","Status","Business","CS Owner","Currency","Total Outstanding","DSO (Days)","Invoices"].map(h=><th key={h} style={S.th}>{h}</th>)}</tr></thead>
            <tbody>
              {dso.length===0?<tr><td colSpan={10} style={{textAlign:"center",padding:40,color:"#9ca3af"}}>No data.</td></tr>
              :dso.map((d,i)=>(
                <tr key={d.customer_id+d.account} style={{background:i%2===0?"#fff":"#f9fafb"}}>
                  <td style={S.td}><span style={acctStyle(d.account)}>{d.account}</span></td>
                  <td style={S.td}><div style={{fontWeight:500}}>{d.customer_name}</div><div style={{fontSize:12,color:"#9ca3af"}}>{d.customer_email}</div></td>
                  <td style={S.td}><span style={{fontSize:13}}>{d.domain||"--"}</span></td>
                  <td style={S.td}><StatusBadge status={d.customer_status}/></td>
                  <td style={S.td}><ColorBadge text={d.business}/></td>
                  <td style={S.td}><span style={{fontSize:12,color:"#374151"}}>{d.cs_email||"--"}</span></td>
                  <td style={S.td}>{d.currency}</td>
                  <td style={{...S.td,fontWeight:600}}>{fmtCurrency(d.total_outstanding,d.currency)}</td>
                  <td style={{...S.td,fontWeight:600,color:d.dso_days>60?"#ef4444":d.dso_days>30?"#f59e0b":"#22c55e"}}>{d.dso_days}d</td>
                  <td style={S.td}>{d.invoice_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div style={{textAlign:"center",padding:"16px 0",color:"#9ca3af",fontSize:12}}>Refreshes every 5 min - Paid, void, draft and uncollectible excluded</div>
    </div>
  );
}
const S:Record<string,React.CSSProperties>={
  page:{maxWidth:1500,margin:"0 auto",padding:"24px 20px"},
  header:{display:"flex",alignItems:"center",justifyContent:"space-between",background:"linear-gradient(135deg,#4f46e5,#7c3aed)",borderRadius:12,padding:"20px 28px",marginBottom:20},
  exportBtn:{background:"#fff",color:"#4f46e5",border:"none",borderRadius:8,padding:"10px 20px",fontWeight:600,fontSize:14,cursor:"pointer",whiteSpace:"nowrap"},
  exportMsg:{background:"#f0fdf4",border:"1px solid #bbf7d0",borderRadius:8,padding:"10px 16px",marginBottom:16,fontSize:13,color:"#166534"},
  statsRow:{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(170px,1fr))",gap:12,marginBottom:20},
  card:{background:"#fff",borderRadius:10,padding:"16px 20px",boxShadow:"0 1px 3px rgba(0,0,0,0.07)"},
  filterBar:{display:"flex",alignItems:"center",gap:10,marginBottom:16,flexWrap:"wrap"},
  searchInput:{border:"1px solid #d1d5db",borderRadius:8,padding:"8px 12px",fontSize:14,width:260,outline:"none"},
  sel:{border:"1px solid #d1d5db",borderRadius:8,padding:"8px 12px",fontSize:14,background:"#fff",cursor:"pointer"},
  tabBtn:{border:"none",borderRadius:8,padding:"8px 14px",fontSize:13,fontWeight:600,cursor:"pointer"},
  tableWrap:{background:"#fff",borderRadius:10,boxShadow:"0 1px 3px rgba(0,0,0,0.07)",overflow:"auto"},
  table:{width:"100%",borderCollapse:"collapse",fontSize:14},
  th:{textAlign:"left",padding:"12px 16px",fontWeight:600,fontSize:13,color:"#374151",cursor:"pointer",userSelect:"none",borderBottom:"2px solid #e5e7eb",whiteSpace:"nowrap"},
  td:{padding:"12px 16px",borderBottom:"1px solid #f3f4f6",verticalAlign:"middle"},
  center:{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",height:"100vh",gap:8},
  spin:{width:36,height:36,border:"4px solid #e5e7eb",borderTop:"4px solid #6366f1",borderRadius:"50%",animation:"spin 0.8s linear infinite"},
};

