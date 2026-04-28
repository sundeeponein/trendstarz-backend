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
  async getAll() {
    const categories = await this.categoryModel.find({}).lean().limit(100);
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
  ) {}

  @Get()
  async getAll(@Query("state") state?: string) {
    const filter: any = {};
    if (state) filter.state = state;
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
    };
  }
}
