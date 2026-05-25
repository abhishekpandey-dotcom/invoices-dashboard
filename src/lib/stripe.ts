import Stripe from "stripe";
import type { CustomerMetaMap } from "./sheets";

export function getStripeClients() {
  const inKey = process.env.STRIPE_IN_SECRET_KEY;
  const usKey = process.env.STRIPE_US_SECRET_KEY;
  if (!inKey || !usKey) throw new Error("Missing Stripe keys. Set STRIPE_IN_SECRET_KEY and STRIPE_US_SECRET_KEY.");
  return { india: new Stripe(inKey, { apiVersion: "2024-04-10" }), us: new Stripe(usKey, { apiVersion: "2024-04-10" }) };
}

export type AgingBucket = "0-30" | "31-60" | "61-90" | "90+";

export interface InvoiceRow {
  id: string; account: "India" | "US"; customer_id: string; customer_name: string; customer_email: string;
  domain: string; business: string; cs_email: string; customer_status: string;
  invoice_number: string; status: string; amount_due: number; currency: string;
  due_date: string | null; days_overdue: number; aging_bucket: AgingBucket; invoice_url: string | null; description: string;
}

export interface CustomerDSO {
  customer_id: string; customer_name: string; customer_email: string;
  domain: string; business: string; cs_email: string; customer_status: string;
  account: "India" | "US"; total_outstanding: number; currency: string; dso_days: number; invoice_count: number;
}

const SKIP = new Set(["paid","void","draft","uncollectible"]);

function bucket(d: number): AgingBucket { return d<=30?"0-30":d<=60?"31-60":d<=90?"61-90":"90+"; }

async function fetchInvoices(stripe: Stripe, account: "India"|"US"): Promise<Omit<InvoiceRow,"domain"|"business"|"cs_email"|"customer_status">[]> {
  const rows: Omit<InvoiceRow,"domain"|"business"|"cs_email"|"customer_status">[] = [];
  const now = Date.now(); let hasMore = true; let startingAfter: string|undefined;
  while (hasMore) {
    const page = await stripe.invoices.list({ status:"open", limit:100, ...(startingAfter?{starting_after:startingAfter}:{}) });
    for (const inv of page.data) {
      if (SKIP.has(inv.status??"")) continue;
      const dueDateMs = inv.due_date ? inv.due_date*1000 : null;
      const daysOverdue = dueDateMs&&dueDateMs<now ? Math.floor((now-dueDateMs)/86_400_000) : 0;
      const cObj = typeof inv.customer==="object"&&inv.customer!==null ? (inv.customer as Stripe.Customer) : null;
      const cId = typeof inv.customer==="string" ? inv.customer : (inv.customer as Stripe.Customer)?.id??"";
      rows.push({ id:inv.id, account, customer_id:cId, customer_name:cObj?.name??inv.customer_name??inv.customer_email??"Unknown", customer_email:cObj?.email??inv.customer_email??"", invoice_number:inv.number??inv.id, status:inv.status??"open", amount_due:inv.amount_due/100, currency:inv.currency.toUpperCase(), due_date:dueDateMs?new Date(dueDateMs).toISOString().split("T")[0]:null, days_overdue:daysOverdue, aging_bucket:bucket(daysOverdue), invoice_url:inv.hosted_invoice_url??null, description:inv.description??"" });
    }
    hasMore = page.has_more; startingAfter = page.data.length>0?page.data[page.data.length-1].id:undefined; if(!page.data.length) hasMore=false;
  }
  return rows;
}

export async function getAllInvoices(metaMap: CustomerMetaMap = new Map()): Promise<{invoices:InvoiceRow[];dso:CustomerDSO[]}> {
  const {india,us} = getStripeClients();
  const [indiaRows,usRows] = await Promise.all([fetchInvoices(india,"India"),fetchInvoices(us,"US")]);
  const invoices: InvoiceRow[] = [...indiaRows,...usRows].map(inv => {
    const meta = metaMap.get(inv.customer_id);
    return { ...inv, domain:meta?.domain??"", business:meta?.business??"", cs_email:meta?.cs_email??"", customer_status:meta?.status??"" };
  });
  const cm = new Map<string,{customer_id:string;customer_name:string;customer_email:string;domain:string;business:string;cs_email:string;customer_status:string;account:"India"|"US";currency:string;totalAmount:number;weightedDays:number;count:number}>();
  for (const inv of invoices) {
    const key = `${inv.account}::${inv.customer_id}::${inv.currency}`;
    if (!cm.has(key)) cm.set(key,{customer_id:inv.customer_id,customer_name:inv.customer_name,customer_email:inv.customer_email,domain:inv.domain,business:inv.business,cs_email:inv.cs_email,customer_status:inv.customer_status,account:inv.account,currency:inv.currency,totalAmount:0,weightedDays:0,count:0});
    const c=cm.get(key)!; c.totalAmount+=inv.amount_due; c.weightedDays+=inv.days_overdue*inv.amount_due; c.count++;
  }
  const dso: CustomerDSO[] = Array.from(cm.values()).map(c=>({customer_id:c.customer_id,customer_name:c.customer_name,customer_email:c.customer_email,domain:c.domain,business:c.business,cs_email:c.cs_email,customer_status:c.customer_status,account:c.account,currency:c.currency,total_outstanding:Math.round(c.totalAmount*100)/100,dso_days:c.totalAmount>0?Math.round(c.weightedDays/c.totalAmount):0,invoice_count:c.count}));
  dso.sort((a,b)=>b.total_outstanding-a.total_outstanding);
  return {invoices,dso};
}
