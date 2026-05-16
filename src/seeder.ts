// Seeder script for initial data and admin user
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { Model } from "mongoose";
import { getModelToken } from "@nestjs/mongoose";
import * as bcrypt from "bcryptjs";
import * as fs from "fs";
import * as path from "path";

export async function seedDatabase(section?: string) {
  // Load admin-config.json for visibility data
  // Try both possible paths for admin-config.json
  let adminConfig = null;
  let adminConfigPath = path.join(__dirname, "../assets/admin-config.json");
  if (!fs.existsSync(adminConfigPath)) {
    adminConfigPath = path.join(process.cwd(), "assets/admin-config.json");
  }
  if (fs.existsSync(adminConfigPath)) {
    adminConfig = JSON.parse(fs.readFileSync(adminConfigPath, "utf-8"));
    console.log("Loaded admin-config:", Object.keys(adminConfig));
  } else {
    console.log("admin-config.json not found at", adminConfigPath);
  }
  const app = await NestFactory.createApplicationContext(AppModule);

  const CategoryModel = app.get<Model<any>>(getModelToken("Category"));
  const LanguageModel = app.get<Model<any>>(getModelToken("Language"));
  const SocialMediaModel = app.get<Model<any>>(getModelToken("SocialMedia"));
  const StateModel = app.get<Model<any>>(getModelToken("State"));
  const DistrictModel = app.get<Model<any>>(getModelToken("District"));
  const UserModel = app.get<Model<any>>(getModelToken("User"));
  const InfluencerModel = app.get<Model<any>>(getModelToken("Influencer"));
  const BrandModel = app.get<Model<any>>(getModelToken("Brand"));
  // ...existing code...

  let sampleUsers: any[] = [];
  let samplePath = path.join(__dirname, "../assets/sample-users.json");
  if (!fs.existsSync(samplePath)) {
    samplePath = path.join(process.cwd(), "assets/sample-users.json");
  }
  if (fs.existsSync(samplePath)) {
    const raw = fs.readFileSync(samplePath, "utf-8");
    sampleUsers = JSON.parse(raw);
  }

  // Only seed the requested section if provided
  if (!section || section === "categories") {
    // Seed all categories
    if (adminConfig?.categories) {
      for (let i = 0; i < adminConfig.categories.length; i++) {
        const cat = adminConfig.categories[i];
        const role =
          cat.role === "influencer" || cat.role === "brand" || cat.role === "both"
            ? cat.role
            : "both";

        let exists = await CategoryModel.findOne({ name: cat.name, role });

        // Migrate a legacy no-role category to role-aware category when possible.
        if (!exists) {
          const legacy = await CategoryModel.findOne({
            name: cat.name,
            role: { $exists: false },
          });
          if (legacy) {
            await CategoryModel.updateOne(
              { _id: legacy._id },
              {
                $set: {
                  role,
                  showInFrontend: cat.visible,
                  sortIndex: i,
                },
              },
            );
            continue;
          }
        }

        if (!exists) {
          await CategoryModel.create({
            name: cat.name,
            role,
            showInFrontend: cat.visible,
            sortIndex: i,
          });
        } else {
          await CategoryModel.updateOne(
            { name: cat.name, role },
            { $set: { showInFrontend: cat.visible, sortIndex: i, role } },
          );
        }
      }
    }
  }
  if (!section || section === "languages") {
    // Seed all languages
    if (adminConfig?.languages) {
      for (const lang of adminConfig.languages) {
        const exists = await LanguageModel.findOne({ name: lang.name });
        if (!exists) {
          await LanguageModel.create({
            name: lang.name,
            showInFrontend: lang.visible,
          });
        } else {
          await LanguageModel.updateOne(
            { name: lang.name },
            { $set: { showInFrontend: lang.visible } },
          );
        }
      }
    }
  }
  if (!section || section === "locations") {
    // Seed all Indian states
    if (adminConfig?.locations) {
      for (const loc of adminConfig.locations) {
        try {
          let stateDoc = await StateModel.findOne({ name: loc.state });
          if (!stateDoc) {
            stateDoc = await StateModel.create({
              name: loc.state,
              showInFrontend: loc.visible,
            });
            console.log(`Inserted state: ${loc.state}`);
          } else {
            await StateModel.updateOne(
              { name: loc.state },
              { $set: { showInFrontend: loc.visible } },
            );
            console.log(`Updated state: ${loc.state}`);
          }
        } catch (err) {
          console.error(`Error inserting/updating state ${loc.state}:`, err);
        }
      }
    }
    // Seed districts nested under states
    if (adminConfig?.locations) {
      for (const loc of adminConfig.locations) {
        if (loc.districts) {
          for (const dist of loc.districts) {
            try {
              let distDoc = await DistrictModel.findOne({
                name: dist.name,
                state: loc.state,
              });
              if (!distDoc) {
                distDoc = await DistrictModel.create({
                  name: dist.name,
                  state: loc.state,
                  showInFrontend: dist.visible,
                });
                console.log(`Inserted district: ${dist.name} (${loc.state})`);
              } else {
                await DistrictModel.updateOne(
                  { name: dist.name, state: loc.state },
                  { $set: { showInFrontend: dist.visible } },
                );
                console.log(`Updated district: ${dist.name} (${loc.state})`);
              }
            } catch (err) {
              console.error(
                `Error inserting/updating district ${dist.name}:`,
                err,
              );
            }
          }
        }
      }
    }
  }
  if (!section || section === "tiers") {
    // Seed tiers with icon and count
    if (adminConfig?.tiers) {
      const TierModel = app.get<Model<any>>(getModelToken("Tier"));
      for (const tier of adminConfig.tiers) {
        try {
          const exists = await TierModel.findOne({ name: tier.name });
          if (!exists) {
            await TierModel.create({
              name: tier.name,
              icon: tier.icon,
              desc: tier.desc,
              showInFrontend: tier.visible,
            });
            console.log(`Inserted tier: ${tier.name}`);
          } else {
            await TierModel.updateOne(
              { name: tier.name },
              {
                $set: {
                  icon: tier.icon,
                  desc: tier.desc,
                  showInFrontend: tier.visible,
                },
              },
            );
            console.log(`Updated tier: ${tier.name}`);
          }
        } catch (err) {
          console.error(`Error inserting/updating tier ${tier.name}:`, err);
        }
      }
      const tierCount = await TierModel.countDocuments();
      console.log(`Seeded Tiers. Total count: ${tierCount}`);
    }
  }
  if (!section || section === "socialMediaPlatforms") {
    // Seed social media platforms
    if (adminConfig?.socialMediaPlatforms) {
      for (const sm of adminConfig.socialMediaPlatforms) {
        try {
          const exists = await SocialMediaModel.findOne({ name: sm.name });
          const fields = {
            showInFrontend: sm.visible,
            icon: sm.icon || null,
            color: sm.color || null,
            handleLabel: sm.handleLabel || "Handle",
            followersLabel: sm.followersLabel || "Followers",
            contentTypes: (sm.contentTypes || []).map((ct: any) => ({
              name: ct.name,
              visible: ct.visible !== false,
            })),
          };
          if (!exists) {
            await SocialMediaModel.create({ name: sm.name, ...fields });
            console.log(`Inserted social media: ${sm.name}`);
          } else {
            await SocialMediaModel.updateOne(
              { name: sm.name },
              { $set: fields },
            );
            console.log(`Updated social media: ${sm.name}`);
          }
        } catch (err) {
          console.error(
            `Error inserting/updating social media ${sm.name}:`,
            err,
          );
        }
      }
    }
  }

  if (!section || section === "users") {
    // Seed Admin User (upsert to avoid duplicate key error)
    const adminSeed = sampleUsers.find((user: any) => user.role === "admin");
    const adminEmail = adminSeed?.email || "admin@trendstarz.com";
    const adminName = adminSeed?.name || "Admin";
    const adminPlainPassword = adminSeed?.password || "admin123";
    const adminPassword = await bcrypt.hash(adminPlainPassword, 10);
    await UserModel.updateOne(
      { email: adminEmail },
      {
        $set: {
          name: adminName,
          password: adminPassword,
          role: "admin",
        },
      },
      { upsert: true },
    );
    console.log(`Seeded admin: ${adminEmail}`);

    // Seed Influencers and Brands from sample-users.json in assets folder
    if (sampleUsers.length > 0) {
      const influencers = sampleUsers.filter((u: any) => u.username);
      const brands = sampleUsers.filter((u: any) => u.brandName);
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
          console.log(`Seeded brand: ${brand.brandName}`);
        }
      }
    } else {
      console.log(
        "sample-users.json not found in assets, skipping influencer/brand seeding.",
      );
    }
  }

  console.log("Seeding complete.");
  await app.close();
}
