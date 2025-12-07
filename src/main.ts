import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import mongoose from 'mongoose';

import { connectMongo } from './mongo-connection';

async function bootstrap() {
  // Enable MongoDB logs BEFORE Nest starts connecting
  mongoose.connection.on('connected', () => {
    console.log('🔥 MongoDB Connected Successfully!');
  });

  mongoose.connection.on('error', (err) => {
    console.error('❌ MongoDB Connection Error:', err);
  });

  mongoose.connection.on('disconnected', () => {
    console.warn('⚠️ MongoDB Disconnected');
  });

  function logMemory(stage: string) {
    const mem = process.memoryUsage();
    console.log(`[MEMORY][${stage}] rss: ${(mem.rss/1024/1024).toFixed(2)}MB heapUsed: ${(mem.heapUsed/1024/1024).toFixed(2)}MB heapTotal: ${(mem.heapTotal/1024/1024).toFixed(2)}MB`);
  }

  logMemory('before connectMongo');
  await connectMongo();
  logMemory('after connectMongo');

  const app = await NestFactory.create(AppModule);
  logMemory('after NestFactory.create');

  app.enableCors({
    origin: [
      'https://trendstarz.in',
      'https://www.trendstarz.in',
      'http://localhost:4200',
    ],
    credentials: true,
  });

  logMemory('before app.listen');
  await app.listen(process.env.PORT || 3000);
  logMemory('after app.listen');
  console.log('🚀 Server started on port', process.env.PORT || 3000);
}

bootstrap();
