import { NestFactory } from "@nestjs/core";
import { ExpressAdapter } from "@nestjs/platform-express";
import express from "express";
import { AppModule } from "./app.module";
import { ResponseInterceptor } from "./response.interceptor";
import * as dotenv from "dotenv";
import helmet from "helmet";
dotenv.config();
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

  const smtpHost = process.env.SMTP_HOST || null;
  const smtpPort = process.env.SMTP_PORT || null;
  const smtpUser = process.env.SMTP_USER || "";
  const smtpConfigured = !!(
    process.env.SMTP_HOST &&
    process.env.SMTP_PORT &&
    process.env.SMTP_USER &&
    process.env.SMTP_PASS
  );
  const [local, domain] = smtpUser.split("@");
  const userMasked = smtpUser
    ? `${local ? `${local.slice(0, 2)}***` : "***"}${domain ? `@${domain}` : ""}`
    : null;
  const nodeEnv = process.env.NODE_ENV || "development";
  const mode =
    nodeEnv === "production"
      ? smtpConfigured
        ? "smtp"
        : "error"
      : smtpConfigured
        ? "smtp"
        : "console-fallback";

  console.log("[EMAIL] Runtime SMTP status:", {
    nodeEnv,
    mode,
    smtpConfigured,
    host: smtpHost,
    port: smtpPort,
    userMasked,
  });

  // Set global API prefix for all routes
  app.setGlobalPrefix("api");

  // Standardize API responses
  app.useGlobalInterceptors(new ResponseInterceptor());

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
    origin: corsOrigins,
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
