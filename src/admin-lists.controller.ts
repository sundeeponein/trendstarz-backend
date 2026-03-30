import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Patch,
  Query,
  UseGuards,
  BadRequestException,
} from "@nestjs/common";
import { JwtAuthGuard } from "./auth/jwt-auth.guard";
import { RolesGuard } from "./auth/roles.guard";
import {
  CategoryModel,
  StateModel,
  SocialMediaModel,
  LanguageModel,
  TierModel,
} from "./database/schemas/profile.schemas";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";

interface VisibilityItem {
  _id: string;
  showInFrontend: boolean;
}

interface BatchVisibilityBody {
  tiers?: VisibilityItem[];
  socialMedia?: VisibilityItem[];
  categories?: VisibilityItem[];
  languages?: VisibilityItem[];
  states?: VisibilityItem[];
}

@Controller("admin")
@UseGuards(JwtAuthGuard, RolesGuard)
export class AdminListsController {
  constructor(
    @InjectModel("Influencer") private readonly influencerModel: Model<any>,
    @InjectModel("Brand") private readonly brandModel: Model<any>,
    @InjectModel("AppSettings") private readonly appSettingsModel: Model<any>,
  ) {}

  @Get("settings")
  async getSettings() {
    // These are the defaults from the schema
    const defaults = {
      preApproveInfluencers: false,
      influencerRequireEmailVerified: true,
      influencerRequireMobileVerified: false,
      preApproveBrands: false,
      brandRequireEmailVerified: true,
      brandRequireMobileVerified: false,
    };
    const settings = await this.appSettingsModel.findOne({}).lean();
    const merged = { ...defaults, ...(settings || {}) };
    console.log("[ADMIN][GET /admin/settings] Returning:", merged);
    return merged;
  }

  @Patch("settings")
  async updateSettings(@Body() body: Record<string, any>) {
    console.log("[ADMIN][PATCH /admin/settings] Incoming body:", body);
    // Only update fields present in the request body
    const settings = await this.appSettingsModel
      .findOneAndUpdate({}, { $set: body }, { upsert: true, new: true })
      .lean();
    console.log("[ADMIN][PATCH /admin/settings] Updated settings:", settings);
    return { success: true, settings };
  }
  // Debug endpoint to log influencer and brand data
  @Get("debug-users")
  async debugUsers() {
    try {
      const influencers = await this.influencerModel.find({}).lean().limit(5);
      const brands = await this.brandModel.find({}).lean().limit(5);
      return { influencers, brands };
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Error fetching debug user data";
      throw new BadRequestException(message);
    }
  }
  // Debug endpoint to check stored public_ids for a specific user (for Cloudinary deletion troubleshooting)
  @Get("debug-user-images/:id")
  async debugUserImages(@Param("id") id: string) {
    let user: any = await this.influencerModel.findById(id).lean();
    if (user) {
      return {
        type: "influencer",
        profileImages: (user.profileImages || []).map((img: any) => ({
          url: typeof img === "object" ? img.url : img,
          public_id: typeof img === "object" ? img.public_id : img,
        })),
      };
    }
    user = await this.brandModel.findById(id).lean();
    if (user) {
      return {
        type: "brand",
        brandLogo: (user.brandLogo || []).map((img: any) => ({
          url: typeof img === "object" ? img.url : img,
          public_id: typeof img === "object" ? img.public_id : img,
        })),
        products: (user.products || []).map((img: any) => ({
          url: typeof img === "object" ? img.url : img,
          public_id: typeof img === "object" ? img.public_id : img,
        })),
      };
    }
    return { message: "User not found", id };
  }

  // Admin dashboard endpoints for influencers and brands
  @Get("influencers")
  async getAllInfluencers(@Query("status") status?: string) {
    const filter = status ? { status } : {};
    const docs = await this.influencerModel.find(filter).lean().limit(200);
    return { success: true, data: docs };
  }

  @Get("brands")
  async getAllBrands(@Query("status") status?: string) {
    const filter = status ? { status } : {};
    const docs = await this.brandModel.find(filter).lean().limit(200);
    return { success: true, data: docs };
  }
  @Patch("states/:id")
  async patchState(
    @Param("id") id: string,
    @Body() body: Record<string, unknown>,
  ) {
    return StateModel.findByIdAndUpdate(id, body, { new: true });
  }

  @Patch("categories/:id")
  async patchCategory(
    @Param("id") id: string,
    @Body() body: Record<string, unknown>,
  ) {
    return CategoryModel.findByIdAndUpdate(id, body, { new: true });
  }

  @Patch("languages/:id")
  async patchLanguage(
    @Param("id") id: string,
    @Body() body: Record<string, unknown>,
  ) {
    return LanguageModel.findByIdAndUpdate(id, body, { new: true });
  }

  @Patch("social-media/:id")
  async patchSocialMedia(
    @Param("id") id: string,
    @Body() body: Record<string, unknown>,
  ) {
    return SocialMediaModel.findByIdAndUpdate(id, body, { new: true });
  }
  @Patch("tiers/:id")
  async patchTier(
    @Param("id") id: string,
    @Body() body: Record<string, unknown>,
  ) {
    return TierModel.findByIdAndUpdate(id, body, { new: true });
  }
  // Categories
  @Get("categories")
  async getCategories() {
    return CategoryModel.find().lean().limit(100);
  }
  @Post("categories")
  async addCategory(@Body() body: { name: string }) {
    return CategoryModel.create(body);
  }
  @Put("categories/:id")
  async updateCategoryFull(
    @Param("id") id: string,
    @Body() body: Record<string, unknown>,
  ) {
    return CategoryModel.findByIdAndUpdate(id, body, { new: true });
  }
  @Delete("categories/:id")
  async deleteCategory(@Param("id") id: string) {
    return CategoryModel.findByIdAndDelete(id);
  }

  // States
  @Get("states")
  async getStates() {
    return StateModel.find().lean().limit(100);
  }
  @Post("states")
  async addState(@Body() body: { name: string }) {
    return StateModel.create(body);
  }
  @Put("states/:id")
  async updateStateFull(
    @Param("id") id: string,
    @Body() body: Record<string, unknown>,
  ) {
    return StateModel.findByIdAndUpdate(id, body, { new: true });
  }
  @Delete("states/:id")
  async deleteState(@Param("id") id: string) {
    return StateModel.findByIdAndDelete(id);
  }

  // Languages
  @Get("languages")
  async getLanguages() {
    return LanguageModel.find().lean().limit(100);
  }
  @Post("languages")
  async addLanguage(@Body() body: { name: string }) {
    return LanguageModel.create(body);
  }
  @Put("languages/:id")
  async updateLanguageFull(
    @Param("id") id: string,
    @Body() body: Record<string, unknown>,
  ) {
    return LanguageModel.findByIdAndUpdate(id, body, { new: true });
  }
  @Delete("languages/:id")
  async deleteLanguage(@Param("id") id: string) {
    return LanguageModel.findByIdAndDelete(id);
  }

  // Social Media
  @Get("social-media")
  async getSocialMedia() {
    // Return all social media entries with new fields
    return SocialMediaModel.find(
      {},
      { socialMedia: 1, handleName: 1, tier: 1, followersCount: 1 },
    )
      .lean()
      .limit(100);
  }
  @Post("social-media")
  async addSocialMedia(
    @Body()
    body: {
      socialMedia: string;
      handleName: string;
      tier: string;
      followersCount: number;
    },
  ) {
    // Create new social media entry with all fields
    return SocialMediaModel.create(body);
  }
  @Put("social-media/:id")
  async updateSocialMediaFull(
    @Param("id") id: string,
    @Body() body: Record<string, unknown>,
  ) {
    return SocialMediaModel.findByIdAndUpdate(id, body, { new: true });
  }
  @Delete("social-media/:id")
  async deleteSocialMedia(@Param("id") id: string) {
    return SocialMediaModel.findByIdAndDelete(id);
  }

  @Post("batch-update-visibility")
  async batchUpdateVisibility(@Body() body: BatchVisibilityBody) {
    try {
      // Each key is an array of {_id, showInFrontend}
      if (body.tiers) {
        for (const t of body.tiers) {
          const result = await TierModel.findByIdAndUpdate(t._id, {
            showInFrontend: t.showInFrontend,
          });
          if (!result) {
            // console.error(`[BatchUpdate] Tier not found:`, t);
            throw new BadRequestException(`Tier not found: ${t._id}`);
          }
        }
      }
      if (body.socialMedia) {
        for (const s of body.socialMedia) {
          const result = await SocialMediaModel.findByIdAndUpdate(s._id, {
            showInFrontend: s.showInFrontend,
          });
          if (!result) {
            // console.error(`[BatchUpdate] SocialMedia not found:`, s);
            throw new BadRequestException(`SocialMedia not found: ${s._id}`);
          }
        }
      }
      if (body.categories) {
        for (const c of body.categories) {
          const result = await CategoryModel.findByIdAndUpdate(c._id, {
            showInFrontend: c.showInFrontend,
          });
          if (!result) {
            // console.error(`[BatchUpdate] Category not found:`, c);
            throw new BadRequestException(`Category not found: ${c._id}`);
          }
        }
      }
      if (body.languages) {
        for (const l of body.languages) {
          const result = await LanguageModel.findByIdAndUpdate(l._id, {
            showInFrontend: l.showInFrontend,
          });
          if (!result) {
            // console.error(`[BatchUpdate] Language not found:`, l);
            throw new BadRequestException(`Language not found: ${l._id}`);
          }
        }
      }
      if (body.states) {
        for (const s of body.states) {
          const result = await StateModel.findByIdAndUpdate(s._id, {
            showInFrontend: s.showInFrontend,
          });
          if (!result) {
            // console.error(`[BatchUpdate] State not found:`, s);
            throw new BadRequestException(`State not found: ${s._id}`);
          }
        }
      }
      return { message: "Visibility updated" };
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Error updating visibility";
      throw new BadRequestException(message);
    }
  }
}
