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
// Removed direct model imports; use @InjectModel for all models
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
  districts?: VisibilityItem[];
}

@Controller("admin")
@UseGuards(JwtAuthGuard, RolesGuard)
export class AdminListsController {
  constructor(
    @InjectModel("Tier") private readonly tierModel: Model<any>,
    @InjectModel("State") private readonly stateModel: Model<any>,
    @InjectModel("District") private readonly districtModel: Model<any>,
    @InjectModel("Category") private readonly categoryModel: Model<any>,
    @InjectModel("SocialMedia") private readonly socialMediaModel: Model<any>,
    @InjectModel("Language") private readonly languageModel: Model<any>,
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
    const filter: any = {};
    if (status === "deleted") {
      filter.isDeleted = true;
    } else if (status) {
      filter.status = status;
      filter.isDeleted = { $ne: true };
    } else {
      filter.isDeleted = { $ne: true };
    }
    const docs = await this.influencerModel.find(filter).lean().limit(200);
    return { success: true, data: docs };
  }

  @Get("brands")
  async getAllBrands(@Query("status") status?: string) {
    const filter: any = {};
    if (status === "deleted") {
      filter.isDeleted = true;
    } else if (status) {
      filter.status = status;
      filter.isDeleted = { $ne: true };
    } else {
      filter.isDeleted = { $ne: true };
    }
    const docs = await this.brandModel.find(filter).lean().limit(200);
    return { success: true, data: docs };
  }
  @Patch("states/:id")
  async patchState(
    @Param("id") id: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.stateModel.findByIdAndUpdate(id, body, { new: true });
  }

  @Patch("categories/:id")
  async patchCategory(
    @Param("id") id: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.categoryModel.findByIdAndUpdate(id, body, { new: true });
  }

  @Patch("languages/:id")
  async patchLanguage(
    @Param("id") id: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.languageModel.findByIdAndUpdate(id, body, { new: true });
  }

  @Patch("social-media/:id")
  async patchSocialMedia(
    @Param("id") id: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.socialMediaModel.findByIdAndUpdate(id, body, { new: true });
  }
  @Patch("tiers/:id")
  async patchTier(
    @Param("id") id: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.tierModel.findByIdAndUpdate(id, body, { new: true });
  }
  // Categories
  @Get("categories")
  async getCategories() {
    return this.categoryModel.find().lean().limit(100);
  }
  @Post("categories")
  async addCategory(@Body() body: { name: string }) {
    return this.categoryModel.create(body);
  }
  @Put("categories/:id")
  async updateCategoryFull(
    @Param("id") id: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.categoryModel.findByIdAndUpdate(id, body, { new: true });
  }
  @Delete("categories/:id")
  async deleteCategory(@Param("id") id: string) {
    return this.categoryModel.findByIdAndDelete(id);
  }

  // States
  @Get("states")
  async getStates() {
    return this.stateModel.find().lean().limit(100);
  }
  @Post("states")
  async addState(@Body() body: { name: string }) {
    return this.stateModel.create(body);
  }
  @Put("states/:id")
  async updateStateFull(
    @Param("id") id: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.stateModel.findByIdAndUpdate(id, body, { new: true });
  }
  @Delete("states/:id")
  async deleteState(@Param("id") id: string) {
    return this.stateModel.findByIdAndDelete(id);
  }

  // Districts
  @Get("districts")
  async getDistricts(
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

    return this.districtModel.find(filter).lean().limit(1000);
  }
  @Post("districts")
  async addDistrict(@Body() body: { name: string; state: string }) {
    return this.districtModel.create(body);
  }
  @Patch("districts/:id")
  async patchDistrict(
    @Param("id") id: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.districtModel.findByIdAndUpdate(id, body, { new: true });
  }
  @Put("districts/:id")
  async updateDistrictFull(
    @Param("id") id: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.districtModel.findByIdAndUpdate(id, body, { new: true });
  }
  @Delete("districts/:id")
  async deleteDistrict(@Param("id") id: string) {
    return this.districtModel.findByIdAndDelete(id);
  }

  // Languages
  @Get("languages")
  async getLanguages() {
    return this.languageModel.find().lean().limit(100);
  }
  @Post("languages")
  async addLanguage(@Body() body: { name: string }) {
    return this.languageModel.create(body);
  }
  @Put("languages/:id")
  async updateLanguageFull(
    @Param("id") id: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.languageModel.findByIdAndUpdate(id, body, { new: true });
  }
  @Delete("languages/:id")
  async deleteLanguage(@Param("id") id: string) {
    return this.languageModel.findByIdAndDelete(id);
  }

  // Social Media
  @Get("social-media")
  async getSocialMedia() {
    // Return all social media entries with new fields
    return this.socialMediaModel
      .find({}, { socialMedia: 1, handleName: 1, tier: 1, followersCount: 1 })
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
    return this.socialMediaModel.create(body);
  }
  @Put("social-media/:id")
  async updateSocialMediaFull(
    @Param("id") id: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.socialMediaModel.findByIdAndUpdate(id, body, { new: true });
  }
  @Delete("social-media/:id")
  async deleteSocialMedia(@Param("id") id: string) {
    return this.socialMediaModel.findByIdAndDelete(id);
  }

  @Post("batch-update-visibility")
  async batchUpdateVisibility(@Body() body: BatchVisibilityBody) {
    try {
      // Debug: print incoming payload
      console.log(
        "[BatchUpdate][INCOMING PAYLOAD]:",
        JSON.stringify(body, null, 2),
      );
      // Each key is an array of {_id, showInFrontend}
      if (body.tiers) {
        for (const t of body.tiers) {
          const result = await this.tierModel.findByIdAndUpdate(t._id, {
            showInFrontend: t.showInFrontend,
          });
          if (!result) {
            throw new BadRequestException(`Tier not found: ${t._id}`);
          }
        }
      }
      if (body.socialMedia) {
        for (const s of body.socialMedia) {
          const result = await this.socialMediaModel.findByIdAndUpdate(s._id, {
            showInFrontend: s.showInFrontend,
          });
          if (!result) {
            throw new BadRequestException(`SocialMedia not found: ${s._id}`);
          }
        }
      }
      if (body.categories) {
        for (const c of body.categories) {
          const result = await this.categoryModel.findByIdAndUpdate(c._id, {
            showInFrontend: c.showInFrontend,
          });
          if (!result) {
            throw new BadRequestException(`Category not found: ${c._id}`);
          }
        }
      }
      if (body.languages) {
        for (const l of body.languages) {
          const result = await this.languageModel.findByIdAndUpdate(l._id, {
            showInFrontend: l.showInFrontend,
          });
          if (!result) {
            throw new BadRequestException(`Language not found: ${l._id}`);
          }
        }
      }
      if (body.states) {
        for (const s of body.states) {
          const result = await this.stateModel.findByIdAndUpdate(s._id, {
            showInFrontend: s.showInFrontend,
          });
          if (!result) {
            console.error(`[BatchUpdate][ERROR] State not found:`, s);
            throw new BadRequestException(`State not found: ${s._id}`);
          }
        }
      }
      if (body.districts) {
        for (const d of body.districts) {
          const result = await this.districtModel.findByIdAndUpdate(d._id, {
            showInFrontend: d.showInFrontend,
          });
          if (!result) {
            console.error(`[BatchUpdate][ERROR] District not found:`, d);
            throw new BadRequestException(`District not found: ${d._id}`);
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
