import { seedDatabase } from "./seeder";

seedDatabase()
  .then(() => {
    console.log("🌱 Seeder finished successfully");
    process.exit(0);
  })
  .catch((err) => {
    console.error("❌ Seeder error:", err);
    process.exit(1);
  });
