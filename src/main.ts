import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors({ origin: true, credentials: true });

  // Debug log for MongoDB URI
  console.log('DEBUG MONGODB_URI:', process.env.MONGODB_URI);

  const port = process.env.PORT || 3000;
  await app.listen(port);
  console.log('Server running on port:', port);
}
bootstrap();
