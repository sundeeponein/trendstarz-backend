import { Controller, Get } from '@nestjs/common';
import { seedDatabase } from './seeder';

@Controller('seed')
export class SeedController {
  @Get()
  async runSeeder() {
    await seedDatabase();
    return { message: 'Database seeding completed!' };
  }
}
