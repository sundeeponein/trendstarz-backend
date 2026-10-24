import Razorpay from "razorpay";
import type { Db } from "mongodb";

export interface ReconcileRow {
  paymentId: string;
  orderId: string;
  amountRupees: number;
  capturedAt: string;
  email: string;
  /** What TrendStarZ has for this order. */
  record: string;
}

export interface ReconcileResult {
  days: number;
  checked: number;
  recorded: number;
  /** Money Razorpay captured that TrendStarZ never completed — needs action. */
  notRecorded: ReconcileRow[];
  /** Captured payments whose order TrendStarZ doesn't know at all. */
  unknownOrder: ReconcileRow[];
}

const PAGE = 100;
const MAX_PAGES = 30;

/**
 * Razorpay vs TrendStarZ, read-only: every payment Razorpay captured in the
 * last `days` days must be completed here (Premium/unlock/re-analysis payment
 * approved, or the campaign payment verified). Catches payments lost while a
 * key or webhook secret was wrong — Razorpay has the money, the user got
 * nothing.
 */
export async function reconcileRazorpay(db: Db, days: number): Promise<ReconcileResult> {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) throw new Error("Razorpay keys are not set");
  const razorpay = new Razorpay({ key_id: keyId, key_secret: keySecret });

  const span = Math.min(Math.max(Math.floor(days) || 7, 1), 60);
  const to = Math.floor(Date.now() / 1000);
  const from = to - span * 24 * 3600;

  const captured: any[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const res: any = await razorpay.payments.all({ from, to, count: PAGE, skip: page * PAGE } as any);
    const items: any[] = res?.items || [];
    captured.push(...items.filter((p) => p.status === "captured"));
    if (items.length < PAGE) break;
  }

  const result: ReconcileResult = { days: span, checked: captured.length, recorded: 0, notRecorded: [], unknownOrder: [] };
  for (const p of captured) {
    const row: ReconcileRow = {
      paymentId: String(p.id || ""),
      orderId: String(p.order_id || ""),
      amountRupees: Math.round(Number(p.amount || 0)) / 100,
      capturedAt: new Date(Number(p.created_at || 0) * 1000).toISOString(),
      email: String(p.email || ""),
      record: "",
    };
    if (!row.orderId) {
      row.record = "no order on the Razorpay payment";
      result.unknownOrder.push(row);
      continue;
    }
    const [payment, txs] = await Promise.all([
      db.collection("payments").findOne({ orderId: row.orderId }, { projection: { status: 1, purpose: 1 } }),
      db
        .collection("campaigntransactions")
        // Same lookup as the payments webhook (the batch id is the Razorpay order id).
        .find(
          { $or: [{ paymentBatchId: row.orderId }, { gatewayOrderId: row.orderId }, { gatewayOrderIds: row.orderId }] },
          { projection: { collectionStatus: 1 } },
        )
        .toArray(),
    ]);
    if (payment) {
      if (payment.status === "approved") result.recorded += 1;
      else {
        row.record = `${payment.purpose || "payment"} is "${payment.status}"`;
        result.notRecorded.push(row);
      }
    } else if (txs.length) {
      if (txs.every((t: any) => t.collectionStatus === "verified")) result.recorded += 1;
      else {
        row.record = `campaign payment is "${txs.map((t: any) => t.collectionStatus).join(", ")}"`;
        result.notRecorded.push(row);
      }
    } else {
      row.record = "order not found in TrendStarZ";
      result.unknownOrder.push(row);
    }
  }
  return result;
}
