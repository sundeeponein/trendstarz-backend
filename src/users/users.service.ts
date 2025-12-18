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
    try {
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
    } catch (err) {
      if (err.code === 11000) {
        const field = Object.keys(err.keyPattern)[0];
        throw new Error(`${field} already exists`);
      }
      throw err;
    }
  }

  async registerBrand(dto: BrandProfileDto) {
    try {
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
    } catch (err) {
      if (err.code === 11000) {
        // Find which field is duplicated
        const field = Object.keys(err.keyPattern)[0];
        throw new Error(`${field} already exists`);
      }
      throw err;
    }
  }

  async getInfluencers() {
    return await this.influencerModel.find({}).lean().limit(100);
  }

  async getBrands() {
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
    if (isPremium && premiumDuration) {
      update.premiumDuration = premiumDuration;
      // Set premiumStart to now, premiumEnd based on duration
      const now = new Date();
      update.premiumStart = now;
      let end = new Date(now);
      if (premiumDuration === '1m') end.setMonth(end.getMonth() + 1);
      else if (premiumDuration === '3m') end.setMonth(end.getMonth() + 3);
      else if (premiumDuration === '1y') end.setFullYear(end.getFullYear() + 1);
      update.premiumEnd = end;
    } else {
      update.premiumDuration = null;
      update.premiumStart = null;
      update.premiumEnd = null;
    }
    const influencer = await this.influencerModel.findByIdAndUpdate(id, update, { new: true });
    if (influencer) return { message: 'Premium status updated', user: influencer };
    const brand = await this.brandModel.findByIdAndUpdate(id, update, { new: true });
    if (brand) return { message: 'Premium status updated', user: brand };
    return { message: 'User not found', id };
  }

  async getInfluencerProfileById(userId: string) {
    const user = await this.influencerModel.findById(userId).lean();
    if (!user || Array.isArray(user)) return null;
    return {
      username: user.username,
      phoneNumber: user.phoneNumber,
      name: user.name,
      email: user.email,
      paymentOption: user.isPremium ? 'premium' : 'free',
      location: user.location || { state: '' },
      languages: user.languages || [],
      categories: user.categories || [],
      website: user.website || '',
      googleMapAddress: user.googleMapAddress || '',
      profileImages: user.profileImages || [],
      socialMedia: user.socialMedia || [],
      contact: user.contact || { whatsapp: false, email: false, call: false },
      isPremium: user.isPremium || false,
      premiumDuration: user.premiumDuration || null,
      premiumStart: user.premiumStart || null,
      premiumEnd: user.premiumEnd || null,
    };
  }

  async getBrandProfileById(userId: string) {
    const user = await this.brandModel.findById(userId).lean();
    if (!user || Array.isArray(user)) return null;
    return {
      brandName: user.brandName,
      phoneNumber: user.phoneNumber,
      email: user.email,
      isPremium: user.isPremium || false,
      paymentOption: user.isPremium ? 'premium' : 'free',
      location: user.location || { state: '' },
      languages: user.languages || [],
      categories: user.categories || [],
      website: user.website || '',
      googleMapAddress: user.googleMapAddress || '',
      brandLogo: user.brandLogo || [],
      productImages: user.products || [],
      socialMedia: user.socialMedia || [],
      contact: user.contact || { whatsapp: false, email: false, call: false },
      premiumDuration: user.premiumDuration || null,
      premiumStart: user.premiumStart || null,
      premiumEnd: user.premiumEnd || null,
    };
  }

  async updateInfluencerProfile(userId: string, update: any) {
    if (update.password) delete update.password;
    const allowedFields = [
      'name', 'username', 'phoneNumber', 'email', 'paymentOption', 'location',
      'languages', 'categories', 'profileImages', 'socialMedia', 'contact'
    ];
    const updateData: any = {};
    for (const key of allowedFields) {
      if (update[key] !== undefined) updateData[key] = update[key];
    }
    if (update.paymentOption) {
      updateData.isPremium = update.paymentOption === 'premium';
    }
    const updated = await this.influencerModel.findByIdAndUpdate(userId, updateData, { new: true });
    if (!updated) return { message: 'Influencer not found', userId };
    return { message: 'Profile updated', user: updated };
  }
  async updateBrandProfile(userId: string, update: any) {
    if (update.password) delete update.password;
    const allowedFields = [
      'brandName', 'phoneNumber', 'email', 'paymentOption', 'location',
      'languages', 'categories', 'brandLogo', 'products', 'website', 'googleMapAddress',
      'productImages', 'socialMedia', 'contact'
    ];
    const updateData: any = {};
    for (const key of allowedFields) {
      if (update[key] !== undefined) updateData[key] = update[key];
    }
    if (update.paymentOption) {
      updateData.isPremium = update.paymentOption === 'premium';
    }
    const updated = await this.brandModel.findByIdAndUpdate(userId, updateData, { new: true });
    if (!updated) return { message: 'Brand not found', userId };
    return { message: 'Profile updated', user: updated };
  }
}