import { Injectable } from '@nestjs/common';
import { CloudinaryService } from '../cloudinary.service';
import { InfluencerProfileDto, BrandProfileDto } from './dto/profile.dto';
import * as bcrypt from 'bcryptjs';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { v2 as cloudinary } from 'cloudinary';

@Injectable()
export class UsersService {
  constructor(
    private readonly cloudinaryService: CloudinaryService,
    @InjectModel('Influencer') private readonly influencerModel: Model<any>,
    @InjectModel('Brand') private readonly brandModel: Model<any>,
  ) {}

  async updateUserImages(id: string, images: { brandLogo?: any[]; products?: any[]; profileImages?: any[] }) {
    console.log('[PATCH] updateUserImages called for id:', id, 'with images:', JSON.stringify(images));
    // Log influencer and brand profileImages before any logic
    let user = await this.influencerModel.findById(id);
    if (user) {
      console.log('[PATCH][DEBUG] Influencer profileImages before update:', JSON.stringify(user.profileImages));
    }
    // Try influencer
    if (user) {
      console.log('[PATCH][DEBUG] Old profileImages:', user.profileImages);
      console.log('[PATCH][DEBUG] New profileImages:', images.profileImages);
    }
    if (user && images.profileImages) {
        console.log('[PATCH][DEBUG] Entered influencer image update block');
      // Remove all old images from Cloudinary if profileImages is being replaced
      if (user.profileImages && Array.isArray(user.profileImages)) {
        for (const oldImg of user.profileImages) {
          if (oldImg && oldImg.public_id) {
            const oldId = String(oldImg.public_id);
            const isStillPresent = images.profileImages.some(newImg => String(newImg.public_id) === oldId);
              console.log('[PATCH][DEBUG] Comparing old public_id:', oldId, 'isStillPresent:', isStillPresent, 'new public_ids:', images.profileImages.map(i => i.public_id));
            if (!isStillPresent) {
              try {
                console.log('[PATCH][DEBUG] Deleting old influencer image with public_id:', oldId);
                await this.cloudinaryService.deleteImage(oldId);
                console.log('[PATCH] Deleted old influencer image from Cloudinary:', oldId);
              } catch (err) {
                console.error('[PATCH] Error deleting old influencer image:', err);
              }
            }
          }
        }
      }
      user.profileImages = images.profileImages;
      await user.save();
      console.log('[PATCH] Influencer images updated:', user.profileImages);
      return { message: 'Influencer images updated', user };
    }
    // Try brand
    user = await this.brandModel.findById(id);
    if (user) {
      // Remove all old brand logos from Cloudinary if brandLogo is being replaced
      if (user.brandLogo && Array.isArray(user.brandLogo) && images.brandLogo) {
        for (const oldImg of user.brandLogo) {
          if (oldImg && oldImg.public_id && (!images.brandLogo.some(newImg => newImg.public_id === oldImg.public_id))) {
            try {
              // Always use the exact public_id as stored
              await this.cloudinaryService.deleteImage(oldImg.public_id);
              console.log('[PATCH] Deleted old brand logo from Cloudinary:', oldImg.public_id);
            } catch (err) {
              console.error('[PATCH] Error deleting old brand logo:', err);
            }
          }
        }
      }
      // Remove all old product images from Cloudinary if products are being replaced
      if (user.products && Array.isArray(user.products) && images.products) {
        for (const oldImg of user.products) {
          if (oldImg && oldImg.public_id && (!images.products.some(newImg => newImg.public_id === oldImg.public_id))) {
            try {
              // Always use the exact public_id as stored
              await this.cloudinaryService.deleteImage(oldImg.public_id);
              console.log('[PATCH] Deleted old brand product image from Cloudinary:', oldImg.public_id);
            } catch (err) {
              console.error('[PATCH] Error deleting old brand product image:', err);
            }
          }
        }
      }
      if (images.brandLogo) user.brandLogo = images.brandLogo;
      if (images.products) user.products = images.products;
      await user.save();
      console.log('[PATCH] Brand images updated:', { brandLogo: user.brandLogo, products: user.products });
      return { message: 'Brand images updated', user };
    }
    console.log('[PATCH] User not found for id:', id);
    return { message: 'User not found', id };
  }

  // Helper for removing a specific influencer image (by index)
  async removeInfluencerImage(id: string, imageIdx: number) {
    const user = await this.influencerModel.findById(id);
    if (user && user.profileImages && user.profileImages[imageIdx]) {
      const img = user.profileImages[imageIdx];
      if (img && img.public_id) {
        let publicId = img.public_id;
        if (publicId && !publicId.includes('/')) publicId = `uploads/${publicId}`;
        try {
          await this.cloudinaryService.deleteImage(publicId);
          user.profileImages.splice(imageIdx, 1);
          await user.save();
          return { message: 'Profile image removed', user };
        } catch (err) {
          console.error('[REMOVE] Error deleting influencer image:', err);
          throw new Error('Failed to remove image');
        }
      }
    }
    return { message: 'Image not found or already removed' };
  }

  async registerInfluencer(dto: InfluencerProfileDto) {
    try {
      if (dto.profileImages && dto.profileImages.length) {
        const uploadedImages = [];
        for (const img of dto.profileImages) {
          if (typeof img === 'object' && img.url && img.public_id) {
            uploadedImages.push(img);
          } else if (typeof img === 'string') {
            if ((img as string).startsWith('http')) {
              uploadedImages.push({ url: img, public_id: '' });
            } else {
              const result = await this.cloudinaryService.uploadImage(img, 'profile_images');
              uploadedImages.push({ url: result.secure_url, public_id: result.public_id });
            }
          } else {
            // fallback for unknown type
            uploadedImages.push({ url: '', public_id: '' });
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
          if (typeof img === 'object' && img.url && img.public_id) {
            uploadedImages.push(img);
          } else if (typeof img === 'string') {
            if ((img as string).startsWith('http')) {
              uploadedImages.push({ url: img, public_id: '' });
            } else {
              const result = await this.cloudinaryService.uploadImage(img, 'profile_images');
              uploadedImages.push({ url: result.secure_url, public_id: result.public_id });
            }
          } else {
            uploadedImages.push({ url: '', public_id: '' });
          }
        }
        dto.brandLogo = uploadedImages;
      }
      if (dto.products && dto.products.length) {
        const uploadedProducts = [];
        for (const img of dto.products) {
          if (typeof img === 'object' && img.url && img.public_id) {
            uploadedProducts.push(img);
          } else if (typeof img === 'string') {
            if ((img as string).startsWith('http')) {
              uploadedProducts.push({ url: img, public_id: '' });
            } else {
              const result = await this.cloudinaryService.uploadImage(img, 'profile_images');
              uploadedProducts.push({ url: result.secure_url, public_id: result.public_id });
            }
          } else {
            uploadedProducts.push({ url: '', public_id: '' });
          }
        }
        dto.products = uploadedProducts;
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

  async restoreUser(id: string) {
    const influencer = await this.influencerModel.findByIdAndUpdate(id, { status: 'pending' }, { new: true });
    if (influencer) return { message: 'User restored', user: influencer };
    const brand = await this.brandModel.findByIdAndUpdate(id, { status: 'pending' }, { new: true });
    if (brand) return { message: 'User restored', user: brand };
    return { message: 'User not found', id };
  }

  async deleteUser(id: string) {
    // Soft delete: set status to 'deleted' for influencer or brand
    const influencer = await this.influencerModel.findById(id);
    if (influencer) {
      await this.influencerModel.findByIdAndUpdate(id, { status: 'deleted' });
      return { message: 'User soft-deleted (influencer)', id };
    }
    const brand = await this.brandModel.findById(id);
    if (brand) {
      await this.brandModel.findByIdAndUpdate(id, { status: 'deleted' });
      return { message: 'User soft-deleted (brand)', id };
    }
    return { message: 'User not found', id };
  }

  async deletePermanently(id: string) {
    try {
      // Try influencer first
      let user = await this.influencerModel.findById(id);
      if (user) {
        // Delete all images from Cloudinary
        if (user.profileImages && Array.isArray(user.profileImages)) {
          for (const img of user.profileImages) {
            if (typeof img === 'object' && img.public_id) {
              // Ensure public_id includes folder if needed
              let publicId = img.public_id;
              if (publicId && !publicId.includes('/')) {
                publicId = `uploads/${publicId}`;
              }
              console.log('Deleting influencer image from Cloudinary, public_id:', publicId);
              try {
                const result = await this.cloudinaryService.deleteImage(publicId);
                console.log('Cloudinary destroy result:', result);
              } catch (cloudErr) {
                console.error('Error deleting influencer image from Cloudinary:', cloudErr, img);
              }
            }
          }
        }
        await this.influencerModel.findByIdAndDelete(id);
        return { message: 'Influencer permanently deleted', user };
      }
      // Try brand
      user = await this.brandModel.findById(id);
      if (user) {
        if (user.brandLogo && Array.isArray(user.brandLogo)) {
          for (const img of user.brandLogo) {
            if (typeof img === 'object' && img.public_id) {
              let publicId = img.public_id;
              if (publicId && !publicId.includes('/')) {
                publicId = `uploads/${publicId}`;
              }
              console.log('Deleting brand logo from Cloudinary, public_id:', publicId);
              try {
                await this.cloudinaryService.deleteImage(publicId);
              } catch (cloudErr) {
                console.error('Error deleting brand logo from Cloudinary:', cloudErr, img);
              }
            }
          }
        }
        if (user.products && Array.isArray(user.products)) {
          for (const img of user.products) {
            if (typeof img === 'object' && img.public_id) {
              let publicId = img.public_id;
              if (publicId && !publicId.includes('/')) {
                publicId = `uploads/${publicId}`;
              }
              console.log('Deleting brand product image from Cloudinary, public_id:', publicId);
              try {
                await this.cloudinaryService.deleteImage(publicId);
              } catch (cloudErr) {
                console.error('Error deleting brand product image from Cloudinary:', cloudErr, img);
              }
            }
          }
        }
        await this.brandModel.findByIdAndDelete(id);
        return { message: 'Brand permanently deleted', user };
      }
      return { message: 'User not found', id };
    } catch (err) {
      console.error('Error in deletePermanently:', err);
      throw new Error('Failed to permanently delete user: ' + (err?.message || err));
    }
  }

  async setPremium(
    id: string,
    isPremium: boolean,
    premiumDuration?: string,
    type?: 'influencer' | 'brand'
  ) {
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
    if (type === 'brand') {
      const brand = await this.brandModel.findByIdAndUpdate(id, update, { new: true });
      if (brand) return { message: 'Premium status updated', user: brand };
    } else {
      const influencer = await this.influencerModel.findByIdAndUpdate(id, update, { new: true });
      if (influencer) return { message: 'Premium status updated', user: influencer };
    }
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

    // Cleanup old images if profileImages is being replaced
    if (update.profileImages) {
      const user = await this.influencerModel.findById(userId);
      console.log('[PATCH][DEBUG] updateInfluencerProfile: userId:', userId);
      console.log('[PATCH][DEBUG] Old profileImages:', user && user.profileImages ? JSON.stringify(user.profileImages) : 'none');
      console.log('[PATCH][DEBUG] New profileImages:', JSON.stringify(update.profileImages));
      if (user && user.profileImages && Array.isArray(user.profileImages)) {
        for (const oldImg of user.profileImages) {
          if (
            oldImg &&
            oldImg.public_id &&
            !update.profileImages.some((img: any) => img.public_id === oldImg.public_id)
          ) {
            try {
              console.log('[PATCH][DEBUG] Deleting old influencer image with public_id:', oldImg.public_id);
              const result = await this.cloudinaryService.deleteImage(oldImg.public_id);
              console.log('[PATCH][DEBUG] Cloudinary delete result for', oldImg.public_id, ':', result);
            } catch (err) {
              console.error('[PATCH][ERROR] Failed to delete influencer image:', oldImg.public_id, err);
            }
          } else {
            console.log('[PATCH][DEBUG] Keeping image (still present):', oldImg && oldImg.public_id);
          }
        }
      }
    }

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

    // Cleanup old brandLogo images if replaced
    if (update.brandLogo) {
      const user = await this.brandModel.findById(userId);
      console.log('[PATCH][DEBUG] updateBrandProfile: userId:', userId);
      console.log('[PATCH][DEBUG] Old brandLogo:', user && user.brandLogo ? JSON.stringify(user.brandLogo) : 'none');
      console.log('[PATCH][DEBUG] New brandLogo:', JSON.stringify(update.brandLogo));
      if (user && user.brandLogo && Array.isArray(user.brandLogo)) {
        for (const oldImg of user.brandLogo) {
          if (
            oldImg &&
            oldImg.public_id &&
            !update.brandLogo.some((img: any) => img.public_id === oldImg.public_id)
          ) {
            try {
              console.log('[PATCH][DEBUG] Deleting old brandLogo image with public_id:', oldImg.public_id);
              const result = await this.cloudinaryService.deleteImage(oldImg.public_id);
              console.log('[PATCH][DEBUG] Cloudinary delete result for brandLogo', oldImg.public_id, ':', result);
            } catch (err) {
              console.error('[PATCH][ERROR] Failed to delete brandLogo image:', oldImg.public_id, err);
            }
          } else {
            console.log('[PATCH][DEBUG] Keeping brandLogo image (still present):', oldImg && oldImg.public_id);
          }
        }
      }
    }

    // Cleanup old product images if replaced
    if (update.products) {
      const user = await this.brandModel.findById(userId);
      console.log('[PATCH][DEBUG] Old products:', user && user.products ? JSON.stringify(user.products) : 'none');
      console.log('[PATCH][DEBUG] New products:', JSON.stringify(update.products));
      if (user && user.products && Array.isArray(user.products)) {
        for (const oldImg of user.products) {
          if (
            oldImg &&
            oldImg.public_id &&
            !update.products.some((img: any) => img.public_id === oldImg.public_id)
          ) {
            try {
              console.log('[PATCH][DEBUG] Deleting old product image with public_id:', oldImg.public_id);
              const result = await this.cloudinaryService.deleteImage(oldImg.public_id);
              console.log('[PATCH][DEBUG] Cloudinary delete result for product', oldImg.public_id, ':', result);
            } catch (err) {
              console.error('[PATCH][ERROR] Failed to delete product image:', oldImg.public_id, err);
            }
          } else {
            console.log('[PATCH][DEBUG] Keeping product image (still present):', oldImg && oldImg.public_id);
          }
        }
      }
    }

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