// Seeder script for initial data and admin user
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { Model } from 'mongoose';
import { getModelToken } from '@nestjs/mongoose';
import * as bcrypt from 'bcryptjs';
import * as fs from 'fs';
import * as path from 'path';

export async function seedDatabase() {
  // Load admin-config.json for visibility data
  // Try both possible paths for admin-config.json
  let adminConfig = null;
  let adminConfigPath = path.join(__dirname, '../assets/admin-config.json');
  if (!fs.existsSync(adminConfigPath)) {
    adminConfigPath = path.join(process.cwd(), 'assets/admin-config.json');
  }
  if (fs.existsSync(adminConfigPath)) {
    adminConfig = JSON.parse(fs.readFileSync(adminConfigPath, 'utf-8'));
    console.log('Loaded admin-config:', Object.keys(adminConfig));
  } else {
    console.log('admin-config.json not found at', adminConfigPath);
  }
  const app = await NestFactory.createApplicationContext(AppModule);

  const CategoryModel = app.get<Model<any>>(getModelToken('Category'));
  const LanguageModel = app.get<Model<any>>(getModelToken('Language'));
  const SocialMediaModel = app.get<Model<any>>(getModelToken('SocialMedia'));
  const StateModel = app.get<Model<any>>(getModelToken('State'));
  const UserModel = app.get<Model<any>>(getModelToken('User'));
  const InfluencerModel = app.get<Model<any>>(getModelToken('Influencer'));
  const BrandModel = app.get<Model<any>>(getModelToken('Brand'));
  // ...existing code...

  // Seed all categories
  if (adminConfig?.categories) {
    for (const cat of adminConfig.categories) {
      const exists = await CategoryModel.findOne({ name: cat.name });
      if (!exists) {
        await CategoryModel.create({ name: cat.name, showInFrontend: cat.visible });
      } else {
        await CategoryModel.updateOne({ name: cat.name }, { $set: { showInFrontend: cat.visible } });
      }
    }
  }

  // Seed all languages
  if (adminConfig?.languages) {
    for (const lang of adminConfig.languages) {
      const exists = await LanguageModel.findOne({ name: lang.name });
      if (!exists) {
        await LanguageModel.create({ name: lang.name, showInFrontend: lang.visible });
      } else {
        await LanguageModel.updateOne({ name: lang.name }, { $set: { showInFrontend: lang.visible } });
      }
    }
  }

  // Seed all Indian states
  if (adminConfig?.locations) {
    for (const loc of adminConfig.locations) {
      try {
        let stateDoc = await StateModel.findOne({ name: loc.state });
        if (!stateDoc) {
          stateDoc = await StateModel.create({ name: loc.state, showInFrontend: loc.visible });
          console.log(`Inserted state: ${loc.state}`);
        } else {
          await StateModel.updateOne({ name: loc.state }, { $set: { showInFrontend: loc.visible } });
          console.log(`Updated state: ${loc.state}`);
        }
      } catch (err) {
        console.error(`Error inserting/updating state ${loc.state}:`, err);
      }
    }
  }

  // Seed tiers with icon and count
  if (adminConfig?.tiers) {
    const TierModel = app.get<Model<any>>(getModelToken('Tier'));
    for (const tier of adminConfig.tiers) {
      try {
        const exists = await TierModel.findOne({ name: tier.name });
        if (!exists) {
          await TierModel.create({ name: tier.name, icon: tier.icon, desc: tier.desc, showInFrontend: tier.visible });
          console.log(`Inserted tier: ${tier.name}`);
        } else {
          await TierModel.updateOne({ name: tier.name }, { $set: { icon: tier.icon, desc: tier.desc, showInFrontend: tier.visible } });
          console.log(`Updated tier: ${tier.name}`);
        }
      } catch (err) {
        console.error(`Error inserting/updating tier ${tier.name}:`, err);
      }
    }
    const tierCount = await TierModel.countDocuments();
    console.log(`Seeded Tiers. Total count: ${tierCount}`);
  }
  if (adminConfig?.socialMediaPlatforms) {
    for (const sm of adminConfig.socialMediaPlatforms) {
      try {
        const exists = await SocialMediaModel.findOne({ name: sm.name });
        if (!exists) {
          await SocialMediaModel.create({ name: sm.name, showInFrontend: sm.visible });
          console.log(`Inserted social media: ${sm.name}`);
        } else {
          await SocialMediaModel.updateOne({ name: sm.name }, { $set: { showInFrontend: sm.visible } });
          console.log(`Updated social media: ${sm.name}`);
        }
      } catch (err) {
        console.error(`Error inserting/updating social media ${sm.name}:`, err);
      }
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

  // Seed Influencers and Brands from sample-users.json in assets folder
  const samplePath = path.join(__dirname, '../assets/sample-users.json');
  if (fs.existsSync(samplePath)) {
    const raw = fs.readFileSync(samplePath, 'utf-8');
    const users = JSON.parse(raw);
    const influencers = users.filter((u: any) => u.username);
    const brands = users.filter((u: any) => u.brandName);
    // Avoid duplicate influencer names and hash passwords
    for (const inf of influencers) {
      const exists = await InfluencerModel.findOne({ email: inf.email });
      if (!exists) {
        const hashed = await bcrypt.hash(inf.password, 10);
        await InfluencerModel.create({ ...inf, password: hashed });
        console.log(`Seeded influencer: ${inf.name}`);
      }
    }
    // Avoid duplicate brand names and hash passwords
    for (const brand of brands) {
      const exists = await BrandModel.findOne({ email: brand.email });
      if (!exists) {
        const hashed = await bcrypt.hash(brand.password, 10);
        await BrandModel.create({ ...brand, password: hashed });
        console.log(`Seeded brand: ${brand.name}`);
      }
    }
  } else {
    console.log('sample-users.json not found in assets, skipping influencer/brand seeding.');
  }

  console.log('Seeding complete. Admin login: admin@trendstarz.com / admin123');
  await app.close();
}
