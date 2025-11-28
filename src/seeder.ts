// Seeder script for initial data and admin user
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { Model } from 'mongoose';
import { getModelToken } from '@nestjs/mongoose';
import * as bcrypt from 'bcryptjs';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule);

  // Models
  const CategoryModel = app.get<Model<any>>(getModelToken('Category'));
  const LanguageModel = app.get<Model<any>>(getModelToken('Language'));
  const SocialMediaModel = app.get<Model<any>>(getModelToken('SocialMedia'));
  const StateModel = app.get<Model<any>>(getModelToken('State'));
  const DistrictModel = app.get<Model<any>>(getModelToken('District'));
  const UserModel = app.get<Model<any>>(getModelToken('User'));

  // Seed data
  await CategoryModel.create([{ name: 'Fashion' }, { name: 'Tech' }, { name: 'Food' }]);
  await LanguageModel.create([{ name: 'English' }, { name: 'Hindi' }]);
  await SocialMediaModel.create([
    {
      socialMedia: 'Facebook',
      handleName: '@oliver1',
      tier: 'Micro', // Tier 4 — Micro (10,000 – 50,000 followers)
      followersCount: 5000 // Example user input
    },
    {
      socialMedia: 'Instagram',
      handleName: '@emma_insta',
      tier: 'Nano', // Tier 2 — Nano (1,000 – 5,000 followers)
      followersCount: 3200
    },
    {
      socialMedia: 'YouTube',
      handleName: '@techguru',
      tier: 'Strong Micro', // Tier 5 — Strong Micro (50,000 – 100,000 followers)
      followersCount: 75000
    }
  ]);
  const states = await StateModel.create([
    { name: 'Maharashtra' },
    { name: 'Karnataka' },
    { name: 'Delhi' }
  ]);
  await DistrictModel.create([
    { name: 'Mumbai', state: states[0]._id },
    { name: 'Bangalore', state: states[1]._id },
    { name: 'Delhi', state: states[2]._id }
  ]);

  // Admin user
  const adminPassword = await bcrypt.hash('admin123', 10);
  await UserModel.create({
    name: 'Admin',
    email: 'admin@trendstarz.com',
    password: adminPassword,
    role: 'admin',
  });

  console.log('Seeding complete. Admin login: admin@trendstarz.com / admin123');
  await app.close();
}

bootstrap();
