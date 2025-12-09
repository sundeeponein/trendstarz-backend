import { Injectable } from '@nestjs/common';
import { CloudinaryService } from '../cloudinary.service';
import { InfluencerProfileDto, BrandProfileDto } from './dto/profile.dto';
import * as bcrypt from 'bcryptjs';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';


@Injectable()
export class UsersService {
  constructor(
    private readonly cloudinaryService: CloudinaryService,
    @InjectModel('Influencer') private readonly influencerModel: Model<any>,
    @InjectModel('Brand') private readonly brandModel: Model<any>,
  ) {}

  async registerInfluencer(dto: InfluencerProfileDto) {
    if (dto.profileImages && dto.profileImages.length) {
      const uploadedImages = [];
      for (const img of dto.profileImages) {
        if (img.startsWith('http')) {
          uploadedImages.push(img);
        } else {
          const result = await this.cloudinaryService.uploadImage(img, 'profile_images');
          uploadedImages.push(result.secure_url);
        }
      }
      dto.profileImages = uploadedImages;
    }
    // Hash password before saving
    if (dto.password) {
      dto.password = await bcrypt.hash(dto.password, 10);
    }
    // Save influencer to DB
  const influencer = new this.influencerModel(dto);
  return await influencer.save();
  }

  async registerBrand(dto: BrandProfileDto) {
    if (dto.brandLogo && dto.brandLogo.length) {
      const uploadedImages = [];
      for (const img of dto.brandLogo) {
        if (img.startsWith('http')) {
          uploadedImages.push(img);
        } else {
          const result = await this.cloudinaryService.uploadImage(img, 'profile_images');
          uploadedImages.push(result.secure_url);
        }
      }
      dto.brandLogo = uploadedImages;
    }
    // Hash password before saving
    if (dto.password) {
      dto.password = await bcrypt.hash(dto.password, 10);
    }
    // Save brand to DB
  const brand = new this.brandModel(dto);
  return await brand.save();
  }

  async getInfluencers() {
    // Use lean and limit for memory efficiency; add skip for pagination if needed
  return await this.influencerModel.find({}).lean().limit(100);
  }

  async getBrands() {
    // Use lean and limit for memory efficiency; add skip for pagination if needed
  return await this.brandModel.find({}).lean().limit(100);
  }

  async acceptUser(id: string) {
  const influencer = await this.influencerModel.findByIdAndUpdate(id, { status: 'accepted' }, { new: true });
    if (influencer) return { message: 'User accepted', user: influencer };
  const brand = await this.brandModel.findByIdAndUpdate(id, { status: 'accepted' }, { new: true });
    if (brand) return { message: 'User accepted', user: brand };
    return { message: 'User not found', id };
  }

  async declineUser(id: string) {
  const influencer = await this.influencerModel.findByIdAndUpdate(id, { status: 'declined' }, { new: true });
    if (influencer) return { message: 'User declined', user: influencer };
  const brand = await this.brandModel.findByIdAndUpdate(id, { status: 'declined' }, { new: true });
    if (brand) return { message: 'User declined', user: brand };
    return { message: 'User not found', id };
  }

  async deleteUser(id: string) {
  const influencer = await this.influencerModel.findByIdAndUpdate(id, { status: 'deleted' }, { new: true });
    if (influencer) return { message: 'User deleted', user: influencer };
  const brand = await this.brandModel.findByIdAndUpdate(id, { status: 'deleted' }, { new: true });
    if (brand) return { message: 'User deleted', user: brand };
    return { message: 'User not found', id };
  }

  async restoreUser(id: string) {
  const influencer = await this.influencerModel.findByIdAndUpdate(id, { status: 'pending' }, { new: true });
    if (influencer) return { message: 'User restored', user: influencer };
  const brand = await this.brandModel.findByIdAndUpdate(id, { status: 'pending' }, { new: true });
    if (brand) return { message: 'User restored', user: brand };
    return { message: 'User not found', id };
  }

  async deletePermanently(id: string) {
  const influencer = await this.influencerModel.findByIdAndDelete(id);
    if (influencer) return { message: 'User permanently deleted', user: influencer };
  const brand = await this.brandModel.findByIdAndDelete(id);
    if (brand) return { message: 'User permanently deleted', user: brand };
    return { message: 'User not found', id };
  }
    async setPremium(id: string, isPremium: boolean, premiumDuration?: string) {
      const update: any = { isPremium };
      if (isPremium && premiumDuration) update.premiumDuration = premiumDuration;
      if (!isPremium) update.premiumDuration = null;
  const influencer = await this.influencerModel.findByIdAndUpdate(id, update, { new: true });
      if (influencer) return { message: 'Premium status updated', user: influencer };
  const brand = await this.brandModel.findByIdAndUpdate(id, update, { new: true });
      if (brand) return { message: 'Premium status updated', user: brand };
      return { message: 'User not found', id };
    }
}
