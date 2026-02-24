import { NestFactory } from '@nestjs/core';
import { ExpressAdapter } from '@nestjs/platform-express';
import express from 'express';
import { AppModule } from './app.module';
import * as dotenv from 'dotenv';
import helmet from 'helmet';
dotenv.config();
// Removed manual mongoose connection logic. Use only MongooseModule.forRoot in AppModule.

async function bootstrap() {
  // MongoDB connection disabled for test deployment
  function logMemory(stage: string) {
    const mem = process.memoryUsage();
    console.log(`[MEMORY][${stage}] rss: ${(mem.rss/1024/1024).toFixed(2)}MB heapUsed: ${(mem.heapUsed/1024/1024).toFixed(2)}MB heapTotal: ${(mem.heapTotal/1024/1024).toFixed(2)}MB`);
  }


  const server = express();
  const app = await NestFactory.create(AppModule, new ExpressAdapter(server));
  logMemory('after NestFactory.create');

  // Set global API prefix for all routes
  app.setGlobalPrefix('api');

  // Security headers
  app.use(helmet());

  // Restrict CORS to trusted origins
  app.enableCors({
    origin: [
      'https://trendstarz.in',
      'https://www.trendstarz.in',
      'http://localhost:4200',
    ],
    credentials: true,
  });

  logMemory('before app.listen');
  const port = process.env.PORT || 3000;
  await app.listen(port, '0.0.0.0');
  logMemory('after app.listen');
  console.log(`🚀 Server started on port ${port}`);

  // Periodic memory logging every 10 seconds
  setInterval(() => {
    logMemory('interval');
  }, 10000);
}

bootstrap();
