import mongoose from 'mongoose';

export async function connectMongo() {

  const uri = process.env.MONGODB_URI;
  console.log("[DEBUG] MONGODB_URI:", uri);

  if (!uri) {
    console.error("❌ MONGODB_URI is missing!");
    return;
  }

  try {
    const conn = await mongoose.connect(uri, {
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
    });

    console.log("🔥 MongoDB Connected:", conn.connection.host);
  } catch (err) {
    console.error("❌ MongoDB Connection Error:", err.message);
  }
}
