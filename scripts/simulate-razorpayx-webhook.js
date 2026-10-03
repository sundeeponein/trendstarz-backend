#!/usr/bin/env node

/*
 * Simulate RazorpayX payout webhook callbacks against local/staging backend.
 *
 * Usage:
 *   WEBHOOK_SECRET=... BASE_URL=http://localhost:3000 \
 *   node scripts/simulate-razorpayx-webhook.js --payoutId pout_123 --status processed
 *
 * Optional:
 *   --event payout.processed
 *   --utr UTR123
 *   --failureReason "UPI handle invalid"
 */

const crypto = require("crypto");

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith("--")) continue;
    const name = key.slice(2);
    const value = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : true;
    out[name] = value;
    if (value !== true) i += 1;
  }
  return out;
}

function resolveEvent(status, explicitEvent) {
  if (explicitEvent) return String(explicitEvent);
  const normalized = String(status || "").toLowerCase();
  if (normalized === "processed") return "payout.processed";
  if (["failed", "reversed", "rejected", "cancelled"].includes(normalized)) {
    return "payout.failed";
  }
  return "payout.updated";
}

async function main() {
  const args = parseArgs(process.argv);
  const baseUrl = String(process.env.BASE_URL || "http://localhost:3000").replace(/\/$/, "");
  const webhookSecret =
    process.env.WEBHOOK_SECRET ||
    process.env.RAZORPAYX_WEBHOOK_SECRET ||
    process.env.RAZORPAY_WEBHOOK_SECRET ||
    "";

  const payoutId = String(args.payoutId || "").trim();
  const status = String(args.status || "processed").trim().toLowerCase();
  const event = resolveEvent(status, args.event);

  if (!payoutId) {
    throw new Error("Missing --payoutId");
  }
  if (!webhookSecret) {
    throw new Error(
      "Missing webhook secret. Set WEBHOOK_SECRET or RAZORPAYX_WEBHOOK_SECRET.",
    );
  }

  const payload = {
    event,
    payload: {
      payout: {
        entity: {
          id: payoutId,
          status,
          utr: args.utr ? String(args.utr) : undefined,
          failure_reason: args.failureReason ? String(args.failureReason) : undefined,
          status_details: args.failureReason
            ? { description: String(args.failureReason) }
            : undefined,
        },
      },
    },
  };

  const body = JSON.stringify(payload);
  const signature = crypto.createHmac("sha256", webhookSecret).update(body).digest("hex");

  const endpoint = `${baseUrl}/api/campaign-transactions/webhooks/razorpayx`;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-razorpay-signature": signature,
    },
    body,
  });

  const text = await res.text();
  let data = text;
  try {
    data = JSON.parse(text);
  } catch {
    // plain text response
  }

  console.log(JSON.stringify({
    endpoint,
    statusCode: res.status,
    response: data,
  }, null, 2));

  if (!res.ok) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("simulate-razorpayx-webhook failed:", err.message || err);
  process.exit(1);
});
