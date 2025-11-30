import { Injectable, UnauthorizedException, BadRequestException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import * as jwt from 'jsonwebtoken';
import { InfluencerModel, BrandModel, UserModel } from '../database/schemas/profile.schemas';

@Injectable()
export class AuthService {
  // Replace with actual user lookup and DB logic
  async login(email: string, password: string) {
    // Try Influencer
    let userDoc = await InfluencerModel.findOne({ email });
    let userType = 'influencer';
    if (!userDoc) {
      // Try Brand
      userDoc = await BrandModel.findOne({ email });
      userType = 'brand';
    }
    if (!userDoc) {
      // Try Admin/User
      userDoc = await UserModel.findOne({ email });
      userType = 'admin';
    }
    if (!userDoc) {
      throw new UnauthorizedException('Invalid credentials');
    }
    const user: any = userDoc.toObject();
    if (!user.password) {
      throw new UnauthorizedException('Invalid credentials');
    }
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      throw new UnauthorizedException('Invalid credentials');
    }
    const token = jwt.sign({ sub: user._id, type: userType }, 'SECRET_KEY', { expiresIn: '7d' });
    return { token, userType };
  }

  async register(body: any) {
    // Determine user type
    const { email, password, username, brandName } = body;
    const hashedPassword = await bcrypt.hash(password, 10);
    let user;
    if (username) {
      // Influencer registration
      if (await InfluencerModel.findOne({ email })) {
        throw new BadRequestException('Email already exists');
      }
      user = new InfluencerModel({ ...body, password: hashedPassword });
      await user.save();
    } else if (brandName) {
      // Brand registration
      if (await BrandModel.findOne({ email })) {
        throw new BadRequestException('Email already exists');
      }
      user = new BrandModel({ ...body, password: hashedPassword });
      await user.save();
    } else {
      throw new BadRequestException('Invalid registration data');
    }
    return { message: 'User registered' };
  }

  async findUserByEmail(email: string) {
    let user = await InfluencerModel.findOne({ email });
    if (!user) {
      user = await BrandModel.findOne({ email });
    }
    return user;
  }
}
