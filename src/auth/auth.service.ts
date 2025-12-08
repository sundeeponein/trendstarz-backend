import { Injectable, UnauthorizedException, BadRequestException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import * as jwt from 'jsonwebtoken';
import { InfluencerModel, BrandModel, UserModel } from '../database/schemas/profile.schemas';
import { sendEmail } from '../utils/email';

const otpStore: Record<string, string> = {};

@Injectable()
export class AuthService {
  // Replace with actual user lookup and DB logic
  async login(email: string, password: string) {
    // ...existing code...
  }

    async registerInfluencer(data: any) {
      // Check if influencer already exists
      const existing = await InfluencerModel.findOne({ email: data.email });
      if (existing) {
        throw new BadRequestException('Influencer already exists');
      }
      // Hash password
      const hashedPassword = await bcrypt.hash(data.password, 10);
      const influencer = new InfluencerModel({
        ...data,
        password: hashedPassword,
      });
      await influencer.save();
      return { success: true, message: 'Influencer registered', influencer };
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
