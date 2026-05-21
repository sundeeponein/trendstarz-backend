import { Injectable, BadRequestException, NotFoundException } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Types } from "mongoose";
import { CloudinaryService } from "../cloudinary.service";

@Injectable()
export class PhotographersService {
  constructor(
    @InjectModel("Photographer") private readonly photographerModel: Model<any>,
    @InjectModel("State") private readonly stateModel: Model<any>,
    @InjectModel("District") private readonly districtModel: Model<any>,
    private readonly cloudinaryService: CloudinaryService,
  ) {}

  private isObjectId(value: any): boolean {
    return !!value && Types.ObjectId.isValid(String(value));
  }

  async getProfile(userId: string) {
    const doc = await this.photographerModel.findById(userId).lean();
    if (!doc) throw new NotFoundException("Photographer not found");
    const { password: _pw, resetToken: _rt, resetTokenExpires: _rte, ...safe } = doc as any;
    return safe;
  }

  async updateProfile(userId: string, data: any) {
    const allowedFields = [
      "name",
      "username",
      "phoneNumber",
      "gender",
      "dateOfBirth",
      "portfolio",
      "location",
      "skills",
      "pricing",
      "equipment",
      "socialMedia",
      "contact",
      "payout",
      "profileImage",
      "profileImagePublicId",
      "profileImages",
    ];
    const update: any = {};

    if (data?.location !== undefined) {
      const stateRaw = data?.location?.state ?? "";
      const districtRaw = data?.location?.district ?? "";
      const stateId = this.isObjectId(stateRaw) ? String(stateRaw) : null;
      const districtId = this.isObjectId(districtRaw) ? String(districtRaw) : null;

      const [stateDoc, districtDoc] = await Promise.all([
        stateId ? this.stateModel.findById(stateId).lean() : null,
        districtId ? this.districtModel.findById(districtId).lean() : null,
      ]);

      update.location = {
        state: stateDoc ? String((stateDoc as any)?.name || "") : String(stateRaw || ""),
        district: districtDoc
          ? String((districtDoc as any)?.name || "")
          : String(districtRaw || ""),
      };
    }

    for (const key of allowedFields) {
      if (key === "location") continue;
      if (data[key] !== undefined) {
        update[key] = data[key];
      }
    }
    const updated = await this.photographerModel
      .findByIdAndUpdate(userId, { $set: update }, { new: true })
      .lean();
    if (!updated) throw new NotFoundException("Photographer not found");
    const { password: _pw, resetToken: _rt, resetTokenExpires: _rte, ...safe } = updated as any;
    return safe;
  }

  async searchPhotographers(query: {
    skill?: string;
    location?: string;
    keyword?: string;
    limit?: number;
    viewerState?: string;
    viewerDistrict?: string;
    smartLocationPriority?: boolean;
  }) {
    const filter: any = { status: "accepted", isDeleted: { $ne: true } };
    if (query.skill) filter.skills = query.skill;
    if (query.location) filter["location.state"] = query.location;

    const limit = Math.min(Number(query.limit) || 60, 100);
    let docs = await this.photographerModel
      .find(filter)
      .select(
        "name username email phoneNumber profileImage profileImages location skills pricing equipment socialMedia contact gender portfolio status adminTags isPremium verifiedByTrendStarz verificationStatus",
      )
      .limit(limit)
      .lean();

    if (query.keyword) {
      const kw = query.keyword.toLowerCase();
      docs = docs.filter((d: any) => {
        const name = (d.name || "").toLowerCase();
        const skills = ((d.skills || []) as string[]).join(" ").toLowerCase();
        return name.includes(kw) || skills.includes(kw);
      });
    }

    const hasManualLocationFilter = !!String(query.location || "").trim();
    const useSmartPriority = !!query.smartLocationPriority && !hasManualLocationFilter;
    const smartLocationMeta = {
      smartLocationPriorityApplied: useSmartPriority,
      manualLocationFilterApplied: hasManualLocationFilter,
      smartLocationContext: {
        viewerState: this.normalizeLocationValue(query.viewerState) || null,
        viewerDistrict: this.normalizeLocationValue(query.viewerDistrict) || null,
      },
    };
    if (useSmartPriority) {
      const viewerState = this.normalizeLocationValue(query.viewerState);
      const viewerDistrict = this.normalizeLocationValue(query.viewerDistrict);
      docs = [...docs].sort((a: any, b: any) => {
        const scoreA = this.getLocationPriorityScore(a, viewerState, viewerDistrict);
        const scoreB = this.getLocationPriorityScore(b, viewerState, viewerDistrict);
        if (scoreA !== scoreB) return scoreB - scoreA;
        const followersA = this.extractTopFollowersCount(a);
        const followersB = this.extractTopFollowersCount(b);
        return followersB - followersA;
      });
    }

    return {
      data: docs,
      ...smartLocationMeta,
    };
  }

  private normalizeLocationValue(value: unknown): string {
    return String(value || "").trim().toLowerCase();
  }

  private getLocationPriorityScore(
    user: any,
    viewerState: string,
    viewerDistrict: string,
  ): number {
    if (!viewerState) return 0;
    const userState = this.normalizeLocationValue(user?.location?.state);
    const userDistrict = this.normalizeLocationValue(user?.location?.district);
    if (viewerDistrict && userDistrict && viewerDistrict === userDistrict) return 100;
    if (userState && viewerState === userState) return 70;
    return 30;
  }

  private extractTopFollowersCount(user: any): number {
    const platforms = Array.isArray(user?.socialMedia) ? user.socialMedia : [];
    return platforms.reduce((max: number, sm: any) => {
      const followers = Number(sm?.followersCount || 0);
      return followers > max ? followers : max;
    }, 0);
  }

  async getPhotographerById(id: string) {
    const doc = await this.photographerModel
      .findOne({ _id: id, status: "accepted", isDeleted: { $ne: true } })
      .select(
        "name username email phoneNumber profileImage profileImages location skills pricing equipment socialMedia contact gender portfolio status adminTags isPremium verifiedByTrendStarz verificationStatus",
      )
      .lean();
    if (!doc) throw new NotFoundException("Photographer not found");
    return doc;
  }
}
