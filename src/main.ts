import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';


async function bootstrap() {
  console.log("Loaded MongoDB URI:", process.env.MONGODB_URI ? "OK" : "Missing");

  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api');
  await app.listen(process.env.PORT ?? 3000);

  console.log(`Server running on port ${process.env.PORT ?? 3000}`);
}
bootstrap();
