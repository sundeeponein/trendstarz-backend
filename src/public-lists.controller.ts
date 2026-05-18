import { Controller, Get, Query } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";

@Controller("tiers")
export class TiersController {
  constructor(@InjectModel("Tier") private readonly tierModel: Model<any>) {}

  @Get()
  async getAll() {
    const tiers = await this.tierModel.find({}).lean().limit(100);
    return tiers.length ? tiers : [];
  }
}

@Controller("languages")
export class LanguagesController {
  constructor(
    @InjectModel("Language") private readonly languageModel: Model<any>,
  ) {}

  @Get()
  async getAll() {
    const languages = await this.languageModel.find({}).lean().limit(100);
    return languages.length ? languages : [];
  }
}

@Controller("categories")
export class CategoriesController {
  constructor(
    @InjectModel("Category") private readonly categoryModel: Model<any>,
  ) {}

  @Get()
  async getAll(@Query("role") role?: string) {
    const normalizedRole = ["influencer", "brand", "photographer", "both"].includes(
      String(role || "").toLowerCase(),
    )
      ? String(role).toLowerCase()
      : "";

    // Prefer explicit role-tagged rows in production.
    // Fallback to legacy role-missing rows only when role data is unavailable.
    if (normalizedRole && normalizedRole !== "both") {
      const roleScoped = await this.categoryModel
        .find({ $or: [{ role: normalizedRole }, { role: "both" }] })
        .sort({ sortIndex: 1, name: 1 })
        .lean()
        .limit(200);

      if (roleScoped.length) {
        return roleScoped;
      }

      const legacyScoped = await this.categoryModel
        .find({ role: { $exists: false } })
        .sort({ sortIndex: 1, name: 1 })
        .lean()
        .limit(200);
      return legacyScoped.length ? legacyScoped : [];
    }

    const categories = await this.categoryModel
      .find({})
      .sort({ sortIndex: 1, name: 1 })
      .lean()
      .limit(200);
    return categories.length ? categories : [];
  }
}

@Controller("states")
export class StatesController {
  constructor(@InjectModel("State") private readonly stateModel: Model<any>) {}

  @Get()
  async getAll() {
    const states = await this.stateModel.find({}).lean().limit(100);
    return states.length ? states : [];
  }
}

@Controller("districts")
export class DistrictsController {
  constructor(
    @InjectModel("District") private readonly districtModel: Model<any>,
    @InjectModel("State") private readonly stateModel: Model<any>,
  ) {}

  @Get()
  async getAll(
    @Query("state") state?: string,
    @Query("stateId") stateId?: string,
  ) {
    let resolvedState = (state || "").trim();

    if (!resolvedState && stateId) {
      const stateDoc: any = await this.stateModel.findById(stateId).lean();
      resolvedState = String(stateDoc?.name || "").trim();
    }

    const filter: any = {};
    if (resolvedState) {
      const escaped = resolvedState.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      filter.state = new RegExp(`^${escaped}$`, "i");
    }

    const districts = await this.districtModel.find(filter).lean().limit(1000);
    return districts.length ? districts : [];
  }
}

@Controller("social-media")
export class SocialMediaController {
  constructor(
    @InjectModel("SocialMedia") private readonly socialMediaModel: Model<any>,
  ) {}

  @Get()
  async getAll() {
    const socials = await this.socialMediaModel.find({}).lean().limit(100);
    return socials.length ? socials : [];
  }
}

/**
 * Public, read-only endpoint that exposes only the support-contact fields
 * from AppSettings. Safe to call from authenticated and unauthenticated
 * pages (e.g. campaign-management banner). Admin-only fields are NOT returned.
 *
 * Post-Razorpay rollout: this endpoint stays. The banner is repurposed as a
 * "Need help? Contact us" channel for queries; admins can hide it via the
 * `enabled` flag or update the message copy.
 */
@Controller("public/support-contact")
export class PublicSupportContactController {
  constructor(
    @InjectModel("AppSettings") private readonly appSettingsModel: Model<any>,
  ) {}

  @Get()
  async get() {
    const settings: any =
      (await this.appSettingsModel.findOne({}).lean()) || {};
    return {
      enabled: settings.supportContactEnabled !== false,
      email: settings.supportContactEmail || "support@trendstarz.in",
      phone: settings.supportContactPhone || "",
      whatsapp: settings.supportContactWhatsapp || "",
      message:
        settings.supportContactMessage ||
        "For now, please contact our team to complete campaign payments. Our admin will update the payment status once received.",
      verificationCallNumber: settings.verificationCallNumber || "",
    };
  }
}

@Controller("equipment-options")
export class EquipmentOptionsController {
  private equipmentOptions: any[] = [];

  constructor() {
    this.loadEquipmentOptions();
  }

  private loadEquipmentOptions() {
    try {
      const fs = require("fs");
      const path = require("path");
      let configPath = path.join(__dirname, "../assets/admin-config.json");
      if (!fs.existsSync(configPath)) {
        configPath = path.join(process.cwd(), "assets/admin-config.json");
      }
      if (fs.existsSync(configPath)) {
        const raw = fs.readFileSync(configPath, "utf-8");
        const config = JSON.parse(raw);
        this.equipmentOptions = (config.equipmentOptions || [])
          .filter((e: any) => e.visible !== false);
      }
    } catch (err) {
      console.error("Error loading equipment options:", err);
      this.equipmentOptions = [];
    }
  }

  @Get()
  async getAll() {
    return this.equipmentOptions.length ? this.equipmentOptions : [];
  }
}

@Controller("pricing-options")
export class PricingOptionsController {
  private pricingOptions: any[] = [];

  constructor() {
    this.loadPricingOptions();
  }

  private loadPricingOptions() {
    try {
      const fs = require("fs");
      const path = require("path");
      let configPath = path.join(__dirname, "../assets/admin-config.json");
      if (!fs.existsSync(configPath)) {
        configPath = path.join(process.cwd(), "assets/admin-config.json");
      }
      if (fs.existsSync(configPath)) {
        const raw = fs.readFileSync(configPath, "utf-8");
        const config = JSON.parse(raw);
        this.pricingOptions = (config.pricingOptions || [])
          .filter((p: any) => p.visible !== false);
      }
    } catch (err) {
      console.error("Error loading pricing options:", err);
      this.pricingOptions = [];
    }
  }

  @Get()
  async getAll() {
    return this.pricingOptions.length ? this.pricingOptions : [];
  }
}

@Controller("user-tag-options")
export class UserTagOptionsController {
  private userTags = {
    influencer: ["Founder", "Internal Creator", "Verified Creator", "Featured Creator"],
    brand: ["Founder-owned", "Partner Brand", "Early Access Brand", "Verified Brand"],
    photographer: ["Founder", "Internal Creator", "Verified Creator", "Featured Creator"],
    commission: ["Early Access", "Partner", "Internal/Test"],
  };

  constructor() {
    this.loadUserTagOptions();
  }

  private loadUserTagOptions() {
    try {
      const fs = require("fs");
      const path = require("path");
      let configPath = path.join(__dirname, "../assets/admin-config.json");
      if (!fs.existsSync(configPath)) {
        configPath = path.join(process.cwd(), "assets/admin-config.json");
      }
      if (!fs.existsSync(configPath)) return;

      const raw = fs.readFileSync(configPath, "utf-8");
      const config = JSON.parse(raw);
      const fromConfig = config?.userTags || {};

      const toList = (value: unknown, fallback: string[]): string[] => {
        if (!Array.isArray(value)) return fallback;
        return value
          .map((item: any) => {
            if (typeof item === "string") {
              return item.trim();
            }
            if (item && typeof item === "object") {
              if (item.visible === false) return "";
              return String(item.name || "").trim();
            }
            return "";
          })
          .filter((v: string) => !!v);
      };

      this.userTags = {
        influencer: toList(fromConfig.influencer, this.userTags.influencer),
        brand: toList(fromConfig.brand, this.userTags.brand),
        photographer: toList(fromConfig.photographer, this.userTags.photographer),
        commission: toList(fromConfig.commission, this.userTags.commission),
      };
    } catch (err) {
      console.error("Error loading user tag options:", err);
    }
  }

  @Get()
  async getAll() {
    this.loadUserTagOptions();
    return this.userTags;
  }
}
