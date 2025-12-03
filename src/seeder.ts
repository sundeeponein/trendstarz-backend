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

  // Seed all categories
  const categoryNames = [
    'Fashion', 'Tech', 'Travel', 'Food', 'Fitness', 'Beauty', 'Education', 'Finance', 'Automobile', 'Gaming', 'Parenting', 'Health', 'Sports', 'Art', 'Music'
  ];
    for (const name of categoryNames) {
      const exists = await CategoryModel.findOne({ name });
      if (!exists) {
        await CategoryModel.create({ name });
      }
    }

  // Seed all languages
  const languageNames = [
    'English', 'Hindi', 'Marathi', 'Kannada', 'Tamil', 'Telugu', 'Gujarati', 'Bengali', 'Punjabi', 'Malayalam', 'Odia', 'Urdu', 'Assamese', 'Konkani'
  ];
    for (const name of languageNames) {
      const exists = await LanguageModel.findOne({ name });
      if (!exists) {
        await LanguageModel.create({ name });
      }
    }

  // Seed all Indian states and relevant districts
  const stateDistricts = [
    { name: 'Andhra Pradesh', districts: ['Visakhapatnam', 'Vijayawada', 'Guntur'] },
    { name: 'Arunachal Pradesh', districts: ['Itanagar'] },
    { name: 'Assam', districts: ['Guwahati', 'Silchar'] },
    { name: 'Bihar', districts: ['Patna', 'Gaya'] },
    { name: 'Chhattisgarh', districts: ['Raipur'] },
    { name: 'Goa', districts: ['Panaji'] },
    { name: 'Gujarat', districts: ['Ahmedabad', 'Surat'] },
    { name: 'Haryana', districts: ['Gurgaon', 'Faridabad'] },
    { name: 'Himachal Pradesh', districts: ['Shimla'] },
    { name: 'Jharkhand', districts: ['Ranchi'] },
    { name: 'Karnataka', districts: ['Bangalore', 'Mysore'] },
    { name: 'Kerala', districts: ['Kochi', 'Thiruvananthapuram'] },
    { name: 'Madhya Pradesh', districts: ['Indore', 'Bhopal'] },
    { name: 'Maharashtra', districts: ['Mumbai', 'Pune', 'Nagpur'] },
    { name: 'Manipur', districts: ['Imphal'] },
    { name: 'Meghalaya', districts: ['Shillong'] },
    { name: 'Mizoram', districts: ['Aizawl'] },
    { name: 'Nagaland', districts: ['Kohima'] },
    { name: 'Odisha', districts: ['Bhubaneswar', 'Cuttack'] },
    { name: 'Punjab', districts: ['Amritsar', 'Ludhiana'] },
    { name: 'Rajasthan', districts: ['Jaipur', 'Udaipur'] },
    { name: 'Sikkim', districts: ['Gangtok'] },
    { name: 'Tamil Nadu', districts: ['Chennai', 'Coimbatore'] },
    { name: 'Telangana', districts: ['Hyderabad', 'Warangal'] },
    { name: 'Tripura', districts: ['Agartala'] },
    { name: 'Uttar Pradesh', districts: ['Lucknow', 'Kanpur', 'Varanasi'] },
    { name: 'Uttarakhand', districts: ['Dehradun'] },
    { name: 'West Bengal', districts: ['Kolkata', 'Darjeeling'] }
  ];
  const states = [];
    for (const sd of stateDistricts) {
      let stateDoc = await StateModel.findOne({ name: sd.name });
      if (!stateDoc) {
        stateDoc = await StateModel.create({ name: sd.name });
      }
      states.push(stateDoc);
      for (const distName of sd.districts) {
        const exists = await DistrictModel.findOne({ name: distName, state: stateDoc._id });
        if (!exists) {
          await DistrictModel.create({ name: distName, state: stateDoc._id });
        }
      }
    }

  // Seed tiers with icon and count
  const tierSeed = [
    { name: 'Starter', icon: '⭐', desc: '1-100 followers' },
    { name: 'Nano', icon: '🌱', desc: '101-1,000 followers' },
    { name: 'Micro', icon: '🔬', desc: '1,001-10,000 followers' },
    { name: 'Mid-Tier', icon: '🎯', desc: '10,001-100,000 followers' },
    { name: 'Macro', icon: '🚀', desc: '100,001-1,000,000 followers' },
    { name: 'Mega / Celebrity', icon: '👑', desc: '1,000,001+ followers' }
  ];
  const TierModel = app.get<Model<any>>(getModelToken('Tier'));
    for (const tier of tierSeed) {
      const exists = await TierModel.findOne({ name: tier.name });
      if (!exists) {
        await TierModel.create(tier);
      }
    }

  // Seed Admin User (upsert to avoid duplicate key error)
  const adminPassword = await bcrypt.hash('admin123', 10);
  await UserModel.updateOne(
    { email: 'admin@trendstarz.com' },
    {
      $set: {
        name: 'Admin',
        password: adminPassword,
        role: 'admin',
      }
    },
    { upsert: true }
  );

  // Seed Influencers and Brands from sample-users.json
  const samplePath = path.join(__dirname, '../sample-users.json');
  if (fs.existsSync(samplePath)) {
    const raw = fs.readFileSync(samplePath, 'utf-8');
    const users = JSON.parse(raw);
    const influencers = users.filter((u: any) => u.username);
    const brands = users.filter((u: any) => u.brandName);
    // Avoid duplicate influencer names
    for (const inf of influencers) {
      const exists = await InfluencerModel.findOne({ name: inf.name });
      if (!exists) {
        await InfluencerModel.create(inf);
        console.log(`Seeded influencer: ${inf.name}`);
      }
    }
    // Avoid duplicate brand names
    for (const brand of brands) {
      const exists = await BrandModel.findOne({ name: brand.name });
      if (!exists) {
        await BrandModel.create(brand);
        console.log(`Seeded brand: ${brand.name}`);
      }
    }
  } else {
    console.log('sample-users.json not found, skipping influencer/brand seeding.');
  }

  console.log('Seeding complete. Admin login: admin@trendstarz.com / admin123');
  await app.close();
}
