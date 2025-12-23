import { Injectable, UnauthorizedException, BadRequestException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import * as jwt from 'jsonwebtoken';
import { InfluencerModel, BrandModel } from '../database/schemas/profile.schemas';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { sendEmail } from '../utils/email';

const otpStore: Record<string, string> = {};

@Injectable()
export class AuthService {
  constructor(
    @InjectModel('User') private readonly userModel: Model<any>,
    @InjectModel('Influencer') private readonly influencerModel: Model<any>,
    @InjectModel('Brand') private readonly brandModel: Model<any>,
    @InjectModel('Category') private readonly categoryModel: Model<any>,
    @InjectModel('State') private readonly stateModel: Model<any>,
    @InjectModel('Language') private readonly languageModel: Model<any>,
    @InjectModel('SocialMedia') private readonly socialMediaModel: Model<any>
  ) {}

  // Admin login implementation
  async login(email: string, password: string) {
    // Try to find admin user
    const user = await this.userModel.findOne({ email, role: 'admin' });
    if (user) {
      const isMatch = await bcrypt.compare(password, user.password);
      if (!isMatch) {
        throw new UnauthorizedException('Invalid credentials');
      }
      // Generate JWT token
      const token = jwt.sign(
        { userId: user._id, email: user.email, role: user.role },
        process.env.JWT_SECRET || 'changeme',
        { expiresIn: '7d' }
      );
      return {
        token,
        userType: user.role,
        user: {
          id: user._id,
          name: user.name,
          email: user.email,
          role: user.role,
          profileImage: user.profileImages && user.profileImages.length > 0 ? user.profileImages[0].url : null,
        },
      };
    }
    // Check influencer
    const influencer = await this.influencerModel.findOne({ email });
    if (influencer) {
      const isMatch = await bcrypt.compare(password, influencer.password);
      if (!isMatch) {
        throw new UnauthorizedException('Invalid credentials');
      }
      if (influencer.status === 'pending') {
        throw new UnauthorizedException('Your account is pending approval. Please wait for admin to activate your account.');
      }
  // Use display name if available, fallback to empty string (never email)
  let displayName = influencer.name && influencer.name !== influencer.email ? influencer.name : '';
  // Use first profile image URL if available
  let profileImageUrl = null;
  if (Array.isArray(influencer.profileImages) && influencer.profileImages.length > 0 && influencer.profileImages[0].url) {
    profileImageUrl = influencer.profileImages[0].url;
  }
  
      // Generate JWT token
      const token = jwt.sign(
        { userId: influencer._id, email: influencer.email, role: 'influencer', name: displayName, profileImage: profileImageUrl },
        process.env.JWT_SECRET || 'changeme',
        { expiresIn: '7d' }
      );
      return {
        token,
        userType: 'influencer',
        user: {
          id: influencer._id,
          name: displayName,
          email: influencer.email,
          role: 'influencer',
          profileImage: profileImageUrl,
        },
      };
    }
    // Check brand
    const brand = await this.brandModel.findOne({ email });
    if (brand) {
      const isMatch = await bcrypt.compare(password, brand.password);
      if (!isMatch) {
        throw new UnauthorizedException('Invalid credentials');
      }
      if (brand.status === 'pending') {
        throw new UnauthorizedException('Your account is pending approval. Please wait for admin to activate your account.');
      }
      // Use display name if available, fallback to email
      const displayName = brand.brandName || brand.email;
      // Use first brand logo URL if available
      const brandLogoUrl = brand.brandLogo && brand.brandLogo.length > 0 ? brand.brandLogo[0].url : null;
      // Generate JWT token
      const token = jwt.sign(
        { userId: brand._id, email: brand.email, role: 'brand', name: displayName, brandLogo: brandLogoUrl },
        process.env.JWT_SECRET || 'changeme',
        { expiresIn: '7d' }
      );
      return {
        token,
        userType: 'brand',
        user: {
          id: brand._id,
          name: displayName,
          email: brand.email,
          role: 'brand',
          brandLogo: brandLogoUrl,
        },
      };
    }
    throw new UnauthorizedException('Invalid credentials');
  }

    async registerInfluencer(data: any) {
  console.log('registerInfluencer called with data:', data);
      // Check if influencer already exists
      const existing = await this.influencerModel.findOne({ email: data.email });
      if (existing) {
        throw new BadRequestException('Influencer already exists');
      }
      // Map category, state, language, and socialMedia platform IDs to names
      const { categories = [], location = {}, languages = [], socialMedia = [] } = data;
      const isObjectId = (val: string) => typeof val === 'string' && /^[a-fA-F0-9]{24}$/.test(val);
      // Fetch names for categories
      let categoryNames = [];
      if (categories.length) {
        categoryNames = await Promise.all(categories.map(async (val: string) => {
          if (isObjectId(val)) {
            const cat = await this.categoryModel.findById(val);
            return cat ? cat.name : val;
          }
          return val;
        }));
      }
      // Fetch state name
      let stateName = location.state;
      if (stateName) {
        if (isObjectId(stateName)) {
          const stateObj = await this.stateModel.findById(stateName);
          stateName = stateObj ? stateObj.name : stateName;
        }
      }
      // Fetch language names
      let languageNames = [];
      if (languages.length) {
        languageNames = await Promise.all(languages.map(async (val: string) => {
          if (isObjectId(val)) {
            const lang = await this.languageModel.findById(val);
            return lang ? lang.name : val;
          }
          return val;
        }));
      }
      // Map socialMedia platform IDs and tier IDs to names
      let socialMediaMapped = [];
      if (socialMedia.length) {
        socialMediaMapped = await Promise.all(socialMedia.map(async (sm: any) => {
          let platformName = sm.platform;
          if (platformName && isObjectId(platformName)) {
            const platformObj = await this.socialMediaModel.findById(platformName);
            platformName = platformObj ? platformObj.name : platformName;
          }
          let tierName = sm.tier;
          // If you have a Tier model injected, add similar logic here
          // Example:
          // if (tierName && isObjectId(tierName) && this.tierModel) {
          //   const tierObj = await this.tierModel.findById(tierName);
          //   tierName = tierObj ? tierObj.name : tierName;
          // }
          return { ...sm, platform: platformName, tier: tierName };
        }));
      }
      // Hash password
      const hashedPassword = await bcrypt.hash(data.password, 10);
      const influencer = new this.influencerModel({
        ...data,
        password: hashedPassword,
        categories: categoryNames,
        location: { state: stateName },
        languages: languageNames,
        socialMedia: socialMediaMapped,
      });
      console.log('Influencer payload:', influencer);
      try {
        const saved = await influencer.save();
        console.log('Influencer saved successfully:', saved._id, 'Collection:', saved.collection.name);
      } catch (err) {
        if (err.name === 'ValidationError') {
          console.error('Influencer validation error:', err.errors);
        } else {
          console.error('Influencer save error:', err);
        }
        throw new BadRequestException('Failed to save influencer: ' + err.message);
      }
      return { success: true, message: 'Influencer registered', influencer };
    }

    async registerBrand(data: any) {
      // Check if brand already exists
      const existing = await this.brandModel.findOne({ email: data.email });
      if (existing) {
        throw new BadRequestException('Brand already exists');
      }
      // Map category, state, language, and socialMedia platform IDs to names
      const { categories = [], location = {}, languages = [], socialMedia = [] } = data;
      const isObjectId = (val: string) => typeof val === 'string' && /^[a-fA-F0-9]{24}$/.test(val);
      // Fetch names for categories
      let categoryNames = [];
      if (categories.length) {
        categoryNames = await Promise.all(categories.map(async (val: string) => {
          if (isObjectId(val)) {
            const cat = await this.categoryModel.findById(val);
            return cat ? cat.name : val;
          }
          return val;
        }));
      }
      // Fetch state name
      let stateName = location.state;
      if (stateName) {
        if (isObjectId(stateName)) {
          const stateObj = await this.stateModel.findById(stateName);
          stateName = stateObj ? stateObj.name : stateName;
        }
      }
      // Fetch language names
      let languageNames = [];
      if (languages.length) {
        languageNames = await Promise.all(languages.map(async (val: string) => {
          if (isObjectId(val)) {
            const lang = await this.languageModel.findById(val);
            return lang ? lang.name : val;
          }
          return val;
        }));
      }
      // Map socialMedia platform IDs and tier IDs to names
      let socialMediaMapped = [];
      if (socialMedia.length) {
        socialMediaMapped = await Promise.all(socialMedia.map(async (sm: any) => {
          let platformName = sm.platform;
          if (platformName && isObjectId(platformName)) {
            const platformObj = await this.socialMediaModel.findById(platformName);
            platformName = platformObj ? platformObj.name : platformName;
          }
          let tierName = sm.tier;
          // If you have a Tier model injected, add similar logic here
          // Example:
          // if (tierName && isObjectId(tierName) && this.tierModel) {
          //   const tierObj = await this.tierModel.findById(tierName);
          //   tierName = tierObj ? tierObj.name : tierName;
          // }
          return { ...sm, platform: platformName, tier: tierName };
        }));
      }
      // Hash password
      const hashedPassword = await bcrypt.hash(data.password, 10);
      const brand = new this.brandModel({
        ...data,
        password: hashedPassword,
        categories: categoryNames,
        location: { state: stateName },
        languages: languageNames,
        socialMedia: socialMediaMapped,
      });
      await brand.save();
      return { success: true, message: 'Brand registered', brand };
    }

  async sendOtp(email: string) {
    // Generate OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    otpStore[email] = otp;
      // Send OTP via email
      try {
        await sendEmail(email, 'Your OTP Code', `Your OTP code is: ${otp}`);
        return { success: true, message: 'OTP sent to email.' };
      } catch (err) {
        console.error('Failed to send OTP email:', err);
        throw new BadRequestException('Failed to send OTP email');
      }
  }

  async verifyOtp(email: string, otp: string) {
    if (otpStore[email] && otpStore[email] === otp) {
      delete otpStore[email];
      return { success: true, message: 'OTP verified.' };
    }
    throw new BadRequestException('Invalid OTP');
  }

  async findUserByEmail(email: string) {
    // ...existing code...
  }
}
