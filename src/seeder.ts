// Seeder script for initial data and admin user
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { Model } from 'mongoose';
import { getModelToken } from '@nestjs/mongoose';
import * as bcrypt from 'bcryptjs';
import * as fs from 'fs';
import * as path from 'path';

export async function seedDatabase() {
  const app = await NestFactory.createApplicationContext(AppModule);

  const CategoryModel = app.get<Model<any>>(getModelToken('Category'));
  const LanguageModel = app.get<Model<any>>(getModelToken('Language'));
  const SocialMediaModel = app.get<Model<any>>(getModelToken('SocialMedia'));
  const StateModel = app.get<Model<any>>(getModelToken('State'));
  const DistrictModel = app.get<Model<any>>(getModelToken('District'));
  const UserModel = app.get<Model<any>>(getModelToken('User'));
  const InfluencerModel = app.get<Model<any>>(getModelToken('Influencer'));
  const BrandModel = app.get<Model<any>>(getModelToken('Brand'));

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

  // Seed Influencers and Brands from sample-users.json
  const samplePath = path.join(__dirname, '../sample-users.json');
  if (fs.existsSync(samplePath)) {
    const raw = fs.readFileSync(samplePath, 'utf-8');
    const users = JSON.parse(raw);
    const influencers = users.filter(u => u.username);
    const brands = users.filter(u => u.brandName);
    if (influencers.length) {
      await InfluencerModel.insertMany(influencers);
      console.log(`Seeded ${influencers.length} influencers.`);
    }
    if (brands.length) {
      await BrandModel.insertMany(brands);
      console.log(`Seeded ${brands.length} brands.`);
    }
  } else {
    console.log('sample-users.json not found, skipping influencer/brand seeding.');
  }

  console.log('Seeding complete. Admin login: admin@trendstarz.com / admin123');
  await app.close();
}
