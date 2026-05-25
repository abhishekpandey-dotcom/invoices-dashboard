import { NextResponse } from "next/server";
import { getAllInvoices } from "@/lib/stripe";
import { readCustomerMetadata } from "@/lib/sheets";

export async function POST() {
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) return NextResponse.json({ error: "Missing RESEND_API_KEY" }, { status: 500 });
  try {
    const metaMap = await readCustomerMetadata().catch(() => new Map());
    const { invoices } = await getAllInvoices(metaMap);
    let inrPerUsd = 84;
    try { const r = await fetch("https://open.er-api.com/v6/latest/USD"); const d = await r.json(); inrPerUsd = d?.rates?.INR ?? 84; } catch { }
    const fmtUSD = (n: number) => new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",maximumFractionDigits:0}).format(n);
    interface CS { b0_30:number;b31_60:number;b61_90:number;b90plus:number;total:number;customers:{name:string;domain:string;email:string;b0_30:number;b31_60:number;b61_90:number;b90plus:number;total:number}[] }
    const csMap = new Map<string,CS>();
    const custMap = new Map<string,{name:string;email:string;domain:string;cs:string;b0_30:number;b31_60:number;b61_90:number;b90plus:number;total:number}>();
    for (const inv of invoices) {
      if (!inv.cs_email) continue;
      const usd = inv.currency==="USD"?inv.amount_due:inv.amount_due/inrPerUsd;
      const key = inv.customer_id+"::"+inv.account;
      if (!custMap.has(key)) custMap.set(key,{name:inv.customer_name,email:inv.customer_email,domain:inv.domain,cs:inv.cs_email,b0_30:0,b31_60:0,b61_90:0,b90plus:0,total:0});
      const c=custMap.get(key)!; c.total+=usd;
      if(inv.aging_bucket==="0-30")c.b0_30+=usd; else if(inv.aging_bucket==="31-60")c.b31_60+=usd; else if(inv.aging_bucket==="61-90")c.b61_90+=usd; else c.b90plus+=usd;
    }
    for (const c of custMap.values()) {
      if(!csMap.has(c.cs)) csMap.set(c.cs,{b0_30:0,b31_60:0,b61_90:0,b90plus:0,total:0,customers:[]});
      const cs=csMap.get(c.cs)!; cs.b0_30+=c.b0_30;cs.b31_60+=c.b31_60;cs.b61_90+=c.b61_90;cs.b90plus+=c.b90plus;cs.total+=c.total;
      cs.customers.push({name:c.name,email:c.email,domain:c.domain,b0_30:c.b0_30,b31_60:c.b31_60,b61_90:c.b61_90,b90plus:c.b90plus,total:c.total});
    }
    const today=new Date().toLocaleDateString("en-IN",{day:"2-digit",month:"short",year:"numeric"});
    const results=[];
    for (const [csEmail,cs] of csMap.entries()) {
      const rows=cs.customers.sort((a,b)=>b.total-a.total).map(c=>`<tr><td style="padding:10px 12px;border-bottom:1px solid #f3f4f6;font-weight:500">${c.name}</td><td style="padding:10px 12px;border-bottom:1px solid #f3f4f6;color:#6b7280;font-size:13px">${c.domain||c.email}</td><td style="padding:10px 12px;border-bottom:1px solid #f3f4f6;color:#22c55e;font-weight:600">${c.b0_30>0?fmtUSD(c.b0_30):"—"}</td><td style="padding:10px 12px;border-bottom:1px solid #f3f4f6;color:#f59e0b;font-weight:600">${c.b31_60>0?fmtUSD(c.b31_60):"—"}</td><td style="padding:10px 12px;border-bottom:1px solid #f3f4f6;color:#f97316;font-weight:600">${c.b61_90>0?fmtUSD(c.b61_90):"—"}</td><td style="padding:10px 12px;border-bottom:1px solid #f3f4f6;color:#ef4444;font-weight:600">${c.b90plus>0?fmtUSD(c.b90plus):"—"}</td><td style="padding:10px 12px;border-bottom:1px solid #f3f4f6;font-weight:700;color:#4f46e5">${fmtUSD(c.total)}</td></tr>`).join("");
      const html=`<div style="font-family:-apple-system,sans-serif;max-width:800px;margin:0 auto;background:#f0f2f5;padding:24px"><div style="background:linear-gradient(135deg,#4f46e5,#7c3aed);border-radius:12px;padding:24px;margin-bottom:20px"><h1 style="color:#fff;margin:0;font-size:20px">Outstanding Invoice Reminder</h1><p style="color:#c7d2fe;margin:6px 0 0;font-size:14px">As of ${today} · All amounts in USD</p></div><div style="background:#fff;border-radius:12px;padding:20px;margin-bottom:16px"><p style="margin:0 0 16px;color:#374151">Hi, here are outstanding invoices for your customers:</p><table style="width:100%;border-collapse:collapse;font-size:14px"><thead><tr style="background:#f8fafc"><th style="padding:10px 12px;text-align:left;border-bottom:2px solid #e5e7eb">Customer</th><th style="padding:10px 12px;text-align:left;border-bottom:2px solid #e5e7eb">Domain</th><th style="padding:10px 12px;text-align:left;color:#22c55e;border-bottom:2px solid #e5e7eb">0-30d</th><th style="padding:10px 12px;text-align:left;color:#f59e0b;border-bottom:2px solid #e5e7eb">31-60d</th><th style="padding:10px 12px;text-align:left;color:#f97316;border-bottom:2px solid #e5e7eb">61-90d</th><th style="padding:10px 12px;text-align:left;color:#ef4444;border-bottom:2px solid #e5e7eb">90+d</th><th style="padding:10px 12px;text-align:left;color:#4f46e5;border-bottom:2px solid #e5e7eb">Total</th></tr></thead><tbody>${rows}</tbody><tfoot><tr><td colspan="6" style="padding:12px;font-weight:700;color:#374151">Total</td><td style="padding:12px;font-weight:700;color:#4f46e5;font-size:16px">${fmtUSD(cs.total)}</td></tr></tfoot></table></div><p style="text-align:center;color:#9ca3af;font-size:12px">Sent by Gushwork Finance</p></div>`;
      const res=await fetch("https://api.resend.com/emails",{method:"POST",headers:{"Authorization":`Bearer ${resendKey}`,"Content-Type":"application/json"},body:JSON.stringify({from:"Finance <finance@gushwork.ai>",to:[csEmail],subject:`Outstanding Invoices - Your Portfolio - ${today}`,html})});
      const json=await res.json();
      results.push({cs_email:csEmail,customers:cs.customers.length,total:fmtUSD(cs.total),status:res.ok?"sent":`failed: ${JSON.stringify(json)}`});
    }
    return NextResponse.json({results,total_emails:results.length});
  } catch(err:unknown){return NextResponse.json({error:err instanceof Error?err.message:"Unknown error"},{status:500});}
}
