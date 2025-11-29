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

  await connectMongo();

  const app = await NestFactory.create(AppModule);

  app.enableCors({
    origin: [
      'https://trendstarz.in',
      'https://www.trendstarz.in',
      'http://localhost:4200',
    ],
    credentials: true,
  });

  await app.listen(process.env.PORT || 3000);
  console.log('🚀 Server started on port', process.env.PORT || 3000);
}

bootstrap();
