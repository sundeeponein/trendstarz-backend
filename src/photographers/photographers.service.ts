import { Injectable, BadRequestException, NotFoundException } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import { CloudinaryService } from "../cloudinary.service";

@Injectable()
export class PhotographersService {
  constructor(
    @InjectModel("Photographer") private readonly photographerModel: Model<any>,
    private readonly cloudinaryService: CloudinaryService,
  ) {}

  async getProfile(userId: string) {
    const doc = await this.photographerModel.findById(userId).lean();
    if (!doc) throw new NotFoundException("Photographer not found");
    const { password: _pw, resetToken: _rt, resetTokenExpires: _rte, ...safe } = doc as any;
    return safe;
  }

  async updateProfile(userId: string, data: any) {
    const allowedFields = [
      "name",
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
      "profileImage",
      "profileImagePublicId",
      "profileImages",
    ];
    const update: any = {};
    for (const key of allowedFields) {
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
  }) {
    const filter: any = { status: "accepted", isDeleted: { $ne: true } };
    if (query.skill) filter.skills = query.skill;
    if (query.location) filter["location.state"] = query.location;

    const limit = Math.min(Number(query.limit) || 60, 100);
    let docs = await this.photographerModel
      .find(filter)
      .select(
        "name email phoneNumber profileImage profileImages location skills pricing equipment socialMedia contact gender portfolio status",
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

    return docs;
  }

  async getPhotographerById(id: string) {
    const doc = await this.photographerModel
      .findOne({ _id: id, status: "accepted", isDeleted: { $ne: true } })
      .select(
        "name email phoneNumber profileImage profileImages location skills pricing equipment socialMedia contact gender portfolio status",
      )
      .lean();
    if (!doc) throw new NotFoundException("Photographer not found");
    return doc;
  }
}
