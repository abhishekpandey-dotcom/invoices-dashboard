import { NextResponse } from "next/server";
import { getAllInvoices } from "@/lib/stripe";
import { readCustomerMetadata } from "@/lib/sheets";

const INR_PER_USD = 95;
const EUR_PER_USD = 1.17;
function toUsd(amount: number, currency: string): number {
  if (currency === "USD") return amount;
  if (currency === "EUR") return Math.round(amount * EUR_PER_USD * 100) / 100;
  return Math.round((amount / INR_PER_USD) * 100) / 100;
}

const CC_EMAILS = [
  "nb@gushwork.ai",
  "akash.shaw@gushwork.ai",
  "tushar.kumar@gushwork.ai",
];

export async function POST() {
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) return NextResponse.json({ error: "Missing RESEND_API_KEY env var." }, { status: 500 });

  try {
    const metaMap = await readCustomerMetadata().catch(() => new Map());
    const { invoices } = await getAllInvoices(metaMap);

    const fmtUSD = (n: number) => new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",maximumFractionDigits:0}).format(n);

    interface CustSummary { customer_name:string;customer_email:string;domain:string;account:string;b0_30:number;b31_60:number;b61_90:number;b90plus:number;total:number; }
    const custMap = new Map<string,CustSummary>();
    for (const inv of invoices) {
      if (!inv.cs_email) continue;
      const usd = toUsd(inv.amount_due, inv.currency);
      const key = `${inv.customer_id}::${inv.account}`;
      if (!custMap.has(key)) custMap.set(key,{customer_name:inv.customer_name,customer_email:inv.customer_email,domain:inv.domain,account:inv.account,b0_30:0,b31_60:0,b61_90:0,b90plus:0,total:0});
      const c=custMap.get(key)!; c.total+=usd;
      if(inv.aging_bucket==="0-30")c.b0_30+=usd; else if(inv.aging_bucket==="31-60")c.b31_60+=usd; else if(inv.aging_bucket==="61-90")c.b61_90+=usd; else c.b90plus+=usd;
    }

    const csMap = new Map<string,{cs_email:string;customers:CustSummary[]}>();
    for (const [key,cust] of custMap.entries()) {
      const csEmail = invoices.find(i=>`${i.customer_id}::${i.account}`===key)?.cs_email ?? "";
      if(!csEmail) continue;
      if(!csMap.has(csEmail)) csMap.set(csEmail,{cs_email:csEmail,customers:[]});
      csMap.get(csEmail)!.customers.push(cust);
    }

    const today = new Date().toLocaleDateString("en-IN",{day:"2-digit",month:"short",year:"numeric"});
    const results = [];

    for (const {cs_email,customers} of csMap.values()) {
      const total = customers.reduce((s,c)=>s+c.total,0);
      const rows = customers.sort((a,b)=>b.total-a.total).map(c=>`
        <tr>
          <td style="padding:10px 12px;border-bottom:1px solid #f3f4f6;font-weight:500">${c.customer_name}</td>
          <td style="padding:10px 12px;border-bottom:1px solid #f3f4f6;color:#6b7280;font-size:13px">${c.domain||c.customer_email}</td>
          <td style="padding:10px 12px;border-bottom:1px solid #f3f4f6;color:#22c55e;font-weight:600">${c.b0_30>0?fmtUSD(c.b0_30):"&mdash;"}</td>
          <td style="padding:10px 12px;border-bottom:1px solid #f3f4f6;color:#f59e0b;font-weight:600">${c.b31_60>0?fmtUSD(c.b31_60):"&mdash;"}</td>
          <td style="padding:10px 12px;border-bottom:1px solid #f3f4f6;color:#f97316;font-weight:600">${c.b61_90>0?fmtUSD(c.b61_90):"&mdash;"}</td>
          <td style="padding:10px 12px;border-bottom:1px solid #f3f4f6;color:#ef4444;font-weight:600">${c.b90plus>0?fmtUSD(c.b90plus):"&mdash;"}</td>
          <td style="padding:10px 12px;border-bottom:1px solid #f3f4f6;font-weight:700;color:#4f46e5">${fmtUSD(c.total)}</td>
        </tr>`).join("");

      const html = `
        <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:800px;margin:0 auto;background:#f0f2f5;padding:24px">
          <div style="background:linear-gradient(135deg,#4f46e5,#7c3aed);border-radius:12px;padding:24px;margin-bottom:20px">
            <h1 style="color:#fff;margin:0;font-size:20px">Outstanding Invoice Reminder</h1>
            <p style="color:#c7d2fe;margin:6px 0 0;font-size:14px">As of ${today} &middot; All amounts in USD</p>
          </div>
          <div style="background:#fff;border-radius:12px;padding:20px;margin-bottom:16px">
            <p style="margin:0 0 16px;color:#374151">Hi, here is a summary of outstanding invoices for your customers:</p>
            <table style="width:100%;border-collapse:collapse;font-size:14px">
              <thead><tr style="background:#f8fafc">
                <th style="padding:10px 12px;text-align:left;border-bottom:2px solid #e5e7eb">Customer</th>
                <th style="padding:10px 12px;text-align:left;border-bottom:2px solid #e5e7eb">Domain</th>
                <th style="padding:10px 12px;text-align:left;color:#22c55e;border-bottom:2px solid #e5e7eb">0-30d</th>
                <th style="padding:10px 12px;text-align:left;color:#f59e0b;border-bottom:2px solid #e5e7eb">31-60d</th>
                <th style="padding:10px 12px;text-align:left;color:#f97316;border-bottom:2px solid #e5e7eb">61-90d</th>
                <th style="padding:10px 12px;text-align:left;color:#ef4444;border-bottom:2px solid #e5e7eb">90+d</th>
                <th style="padding:10px 12px;text-align:left;color:#4f46e5;border-bottom:2px solid #e5e7eb">Total</th>
              </tr></thead>
              <tbody>${rows}</tbody>
              <tfoot><tr>
                <td colspan="6" style="padding:12px;font-weight:700;color:#374151">Total Outstanding</td>
                <td style="padding:12px;font-weight:700;color:#4f46e5;font-size:16px">${fmtUSD(total)}</td>
              </tr></tfoot>
            </table>
          </div>
          <p style="text-align:center;color:#9ca3af;font-size:12px">Sent by Gushwork Finance &middot; Data from Stripe</p>
        </div>`;

      const res = await fetch("https://api.resend.com/emails",{
        method:"POST",
        headers:{"Authorization":`Bearer ${resendKey}`,"Content-Type":"application/json"},
        body:JSON.stringify({
          from:"Gushwork Finance <onboarding@resend.dev>",
          to:[cs_email],
          cc: CC_EMAILS,
          reply_to:"finance.abhishek@gushwork.ai",
          subject:`Outstanding Invoices — Your Portfolio — ${today}`,
          html
        })
      });
      const json = await res.json();
      results.push({cs_email,customers:customers.length,status:res.ok?"sent":`failed: ${JSON.stringify(json)}`});
    }

    return NextResponse.json({results,total_emails:results.length});
  } catch(err:unknown) {
    return NextResponse.json({error:err instanceof Error?err.message:"Unknown error"},{status:500});
  }
}
