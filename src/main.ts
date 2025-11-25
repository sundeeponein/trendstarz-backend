import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import dotenv from 'dotenv';
dotenv.config();

async function bootstrap() {
  console.log("Loaded MongoDB URI:", process.env.MONGODB_URI ? "OK" : "Missing");

  const app = await NestFactory.create(AppModule);
  await app.listen(process.env.PORT ?? 3000);

  console.log(`Server running on port ${process.env.PORT ?? 3000}`);
}
bootstrap();
