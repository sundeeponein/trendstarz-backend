#!/usr/bin/env node

/*
 * Calls admin gateway readiness endpoint and prints payment mode matrix.
 *
 * Usage:
 *   BASE_URL=http://localhost:3000 ADMIN_TOKEN=<jwt> node scripts/check-gateway-readiness.js
 */

async function main() {
  const baseUrl = String(process.env.BASE_URL || "http://localhost:3000").replace(/\/$/, "");
  const token = String(process.env.ADMIN_TOKEN || "").trim();

  if (!token) {
    throw new Error("Missing ADMIN_TOKEN environment variable");
  }

  const endpoint = `${baseUrl}/api/campaign-transactions/admin/gateway-readiness`;
  const res = await fetch(endpoint, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  const text = await res.text();
  let data = text;
  try {
    data = JSON.parse(text);
  } catch {
    // keep raw text
  }

  console.log(JSON.stringify({ endpoint, statusCode: res.status, response: data }, null, 2));
  if (!res.ok) process.exitCode = 1;
}

main().catch((err) => {
  console.error("check-gateway-readiness failed:", err.message || err);
  process.exit(1);
});
