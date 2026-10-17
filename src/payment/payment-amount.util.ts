/**
 * Payment.amount was written in two units: Razorpay rows in paise, manual UPI
 * rows in rupees. New rows also store amountPaise (always paise); this reads
 * it, falling back to the old per-gateway rule for rows written before it
 * existed (cron/backfillPaymentAmountPaise.js fills those).
 */
export function isLegacyPaiseRow(row: any): boolean {
  return (
    row?.gatewayProvider === "razorpay" || row?.paymentMethod === "razorpay"
  );
}

export function paymentAmountPaise(row: any): number {
  if (typeof row?.amountPaise === "number") return row.amountPaise;
  const amount = Number(row?.amount || 0);
  if (!Number.isFinite(amount)) return 0;
  return isLegacyPaiseRow(row) ? Math.round(amount) : Math.round(amount * 100);
}

export function paymentAmountRupees(row: any): number {
  return paymentAmountPaise(row) / 100;
}
