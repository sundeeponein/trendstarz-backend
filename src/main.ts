import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import mongoose from 'mongoose';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // ===== MONGOOSE DEBUG LOGS =====
  mongoose.connection.on('connected', () => {
    console.log('🔥 MongoDB Connected Successfully!');
  });

  mongoose.connection.on('error', (err) => {
    console.log('❌ MongoDB Connection Error:', err);
  });

  mongoose.connection.on('disconnected', () => {
    console.log('⚠️ MongoDB Disconnected!');
  });
  // ================================

  app.enableCors({
    origin: [
      'https://trendstarz.in',
      'https://www.trendstarz.in',
      'http://localhost:4200'
    ],
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    allowedHeaders: 'Content-Type, Authorization',
    credentials: true,
  });

  const port = process.env.PORT || 3000;
  await app.listen(port);

  console.log('Server running on port:', port);
}

bootstrap();
