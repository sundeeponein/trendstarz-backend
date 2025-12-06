import { Injectable } from '@nestjs/common';
import { CloudinaryService } from '../cloudinary.service';
import { InfluencerProfileDto, BrandProfileDto } from './dto/profile.dto';
import { InfluencerModel, BrandModel } from '../database/schemas/profile.schemas';

@Injectable()
export class UsersService {
  constructor(private readonly cloudinaryService: CloudinaryService) {}

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
  }

  async getInfluencers() {
    return await InfluencerModel.find({});
  }

  async getBrands() {
    return await BrandModel.find({});
  }

  async acceptUser(id: string) {
    const influencer = await InfluencerModel.findByIdAndUpdate(id, { status: 'accepted' }, { new: true });
    if (influencer) return { message: 'User accepted', user: influencer };
    const brand = await BrandModel.findByIdAndUpdate(id, { status: 'accepted' }, { new: true });
    if (brand) return { message: 'User accepted', user: brand };
    return { message: 'User not found', id };
  }

  async declineUser(id: string) {
    const influencer = await InfluencerModel.findByIdAndUpdate(id, { status: 'declined' }, { new: true });
    if (influencer) return { message: 'User declined', user: influencer };
    const brand = await BrandModel.findByIdAndUpdate(id, { status: 'declined' }, { new: true });
    if (brand) return { message: 'User declined', user: brand };
    return { message: 'User not found', id };
  }

  async deleteUser(id: string) {
    const influencer = await InfluencerModel.findByIdAndUpdate(id, { status: 'deleted' }, { new: true });
    if (influencer) return { message: 'User deleted', user: influencer };
    const brand = await BrandModel.findByIdAndUpdate(id, { status: 'deleted' }, { new: true });
    if (brand) return { message: 'User deleted', user: brand };
    return { message: 'User not found', id };
  }

  async restoreUser(id: string) {
    const influencer = await InfluencerModel.findByIdAndUpdate(id, { status: 'pending' }, { new: true });
    if (influencer) return { message: 'User restored', user: influencer };
    const brand = await BrandModel.findByIdAndUpdate(id, { status: 'pending' }, { new: true });
    if (brand) return { message: 'User restored', user: brand };
    return { message: 'User not found', id };
  }

  async deletePermanently(id: string) {
    const influencer = await InfluencerModel.findByIdAndDelete(id);
    if (influencer) return { message: 'User permanently deleted', user: influencer };
    const brand = await BrandModel.findByIdAndDelete(id);
    if (brand) return { message: 'User permanently deleted', user: brand };
    return { message: 'User not found', id };
  }
    async setPremium(id: string, isPremium: boolean) {
      const influencer = await InfluencerModel.findByIdAndUpdate(id, { isPremium }, { new: true });
      if (influencer) return { message: 'Premium status updated', user: influencer };
      const brand = await BrandModel.findByIdAndUpdate(id, { isPremium }, { new: true });
      if (brand) return { message: 'Premium status updated', user: brand };
      return { message: 'User not found', id };
    }
}
