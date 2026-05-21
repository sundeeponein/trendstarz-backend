// Polyfill global `crypto` for Node.js < 19 (e.g. Node 18 on Railway)
import { webcrypto } from "node:crypto";
if (!globalThis.crypto) {
  Object.defineProperty(globalThis, "crypto", { value: webcrypto });
}

import { seedDatabase } from "./seeder";
const section = process.argv[2]; // e.g. "socialMediaPlatforms"

const allowedSections = new Set([
  "categories",
  "languages",
  "locations",
  "tiers",
  "socialMediaPlatforms",
  "users",
  "plans",
]);

if (section && !allowedSections.has(section)) {
  console.error(
    `❌ Invalid seeder section: "${section}". Allowed values: ${Array.from(allowedSections).join(", ")}`,
  );
  process.exit(1);
}

seedDatabase(section)
  .then(() => {
    console.log("🌱 Seeder finished successfully");
    process.exit(0);
  })
  .catch((err) => {
    console.error("❌ Seeder error:", err);
    process.exit(1);
  });
