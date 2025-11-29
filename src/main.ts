import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {

  // ---- Seed ONLY when RUN_SEED=true ----
  if (process.env.RUN_SEED === 'true') {
    console.log('🚀 RUN_SEED=true — Running seeder.js...');
    const { seedDatabase } = await import('./seeder.js');
    await seedDatabase();
    console.log('✅ Seed completed successfully.');
    // IMPORTANT: Return here so the server doesn't run twice
    return;
  }

  const app = await NestFactory.create(AppModule);
  app.enableCors({ origin: true, credentials: true });

  console.log('DEBUG MONGODB_URI:', process.env.MONGODB_URI);

  const port = process.env.PORT || 3000;
  await app.listen(port);

  console.log('Server running on port:', port);
}

bootstrap();
