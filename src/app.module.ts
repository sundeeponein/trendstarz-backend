// import { SeedController } from './seed.controller';

// import { Module } from '@nestjs/common';
import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';



// 🚨 Seeder is now disabled for production deployment to avoid high memory usage.
// To seed manually, run: npm run seeder or node dist/run-seeder.js

@Module({
  controllers: [HealthController],
  providers: [],
})
export class AppModule {}