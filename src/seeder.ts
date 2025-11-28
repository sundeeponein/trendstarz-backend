// Seeder script for initial data and admin user
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { Model } from 'mongoose';
import { getModelToken } from '@nestjs/mongoose';
import * as bcrypt from 'bcryptjs';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule);

  const CategoryModel = app.get<Model<any>>(getModelToken('Category'));
  const LanguageModel = app.get<Model<any>>(getModelToken('Language'));
  const SocialMediaModel = app.get<Model<any>>(getModelToken('SocialMedia'));
  const StateModel = app.get<Model<any>>(getModelToken('State'));
  const DistrictModel = app.get<Model<any>>(getModelToken('District'));
  const UserModel = app.get<Model<any>>(getModelToken('User'));

  // Seed Categories
  await CategoryModel.insertMany([
    { name: 'Fashion' },
    { name: 'Tech' },
    { name: 'Food' }
  ]);

  // Seed Languages
  await LanguageModel.insertMany([
    { name: 'English' },
    { name: 'Hindi' }
  ]);

  // Seed Social Media (correct schema)
  await SocialMediaModel.insertMany([
    {
      name: 'Facebook',
      icon: 'facebook.svg',
      url: 'https://facebook.com'
    },
    {
      name: 'Instagram',
      icon: 'instagram.svg',
      url: 'https://instagram.com'
    },
    {
      name: 'YouTube',
      icon: 'youtube.svg',
      url: 'https://youtube.com'
    }
  ]);

  // Seed States
  const states = await StateModel.insertMany([
    { name: 'Maharashtra' },
    { name: 'Karnataka' },
    { name: 'Delhi' }
  ]);

  // Seed Districts
  await DistrictModel.insertMany([
    { name: 'Mumbai', state: states[0]._id },
    { name: 'Bangalore', state: states[1]._id },
    { name: 'Delhi', state: states[2]._id }
  ]);

  // Seed Admin User
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