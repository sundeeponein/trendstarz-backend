// Polyfill global `crypto` for Node.js < 19 (e.g. Node 18 on Railway)
import { webcrypto } from "node:crypto";
if (!globalThis.crypto) {
  Object.defineProperty(globalThis, "crypto", { value: webcrypto });
}

import { NestFactory } from "@nestjs/core";
import { ExpressAdapter } from "@nestjs/platform-express";
import express from "express";
import { AppModule } from "./app.module";
import { ResponseInterceptor } from "./response.interceptor";
import { ValidationPipe } from "@nestjs/common";
import * as dotenv from "dotenv";
import helmet from "helmet";
dotenv.config();
import * as path from 'path';
// Removed manual mongoose connection logic. Use only MongooseModule.forRoot in AppModule.

async function bootstrap() {
  // MongoDB connection disabled for test deployment
  function logMemory(stage: string) {
    const mem = process.memoryUsage();
    console.log(
      `[MEMORY][${stage}] rss: ${(mem.rss / 1024 / 1024).toFixed(2)}MB heapUsed: ${(mem.heapUsed / 1024 / 1024).toFixed(2)}MB heapTotal: ${(mem.heapTotal / 1024 / 1024).toFixed(2)}MB`,
    );
  }

  const server = express();
  const app = await NestFactory.create(AppModule, new ExpressAdapter(server));
  logMemory("after NestFactory.create");

  // Serve static files for local image uploads
  server.use('/assets', express.static(path.join(__dirname, 'assets')));



  // Set global API prefix for all routes
  app.setGlobalPrefix("api");

  // Standardize API responses
  app.useGlobalInterceptors(new ResponseInterceptor());

  // Validate and strip unknown fields from all request bodies globally.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // Strip properties not in the DTO
      forbidNonWhitelisted: false, // Don't hard-reject (untyped bodies on other endpoints still pass)
      transform: true, // Auto-transform primitives (e.g., @Transform decorators in DTOs)
    }),
  );

  // Security headers
  app.use(helmet());

  // Restrict CORS to trusted origins (configurable via environment variable)
  const corsOrigins = (
    process.env.CORS_ORIGINS ||
    "https://trendstarz.in,https://www.trendstarz.in,http://localhost:4200,http://127.0.0.1:4200"
  )
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  app.enableCors({
    origin: (
      origin: string | undefined,
      callback: (err: Error | null, allow?: boolean) => void,
    ) => {
      // Allow requests with no origin (like mobile apps, curl, etc.)
      if (!origin) return callback(null, true);
      if (corsOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error("Not allowed by CORS"));
    },
    credentials: true,
  });

  logMemory("before app.listen");
  const port = process.env.PORT || 3000;
  await app.listen(port, "0.0.0.0");
  logMemory("after app.listen");
  console.log(`🚀 Server started on port ${port}`);

  // Periodic memory logging every 10 seconds
  setInterval(() => {
    logMemory("interval");
  }, 10000);
}

void bootstrap();
