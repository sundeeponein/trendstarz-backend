import { Injectable, UnauthorizedException, BadRequestException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import * as jwt from 'jsonwebtoken';
import { InfluencerModel, BrandModel, UserModel } from '../database/schemas/profile.schemas';

const otpStore: Record<string, string> = {};

@Injectable()
export class AuthService {
  // Replace with actual user lookup and DB logic
  async login(email: string, password: string) {
    // ...existing code...
  }

  async sendOtp(email: string) {
    // Generate OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    otpStore[email] = otp;
    // TODO: Integrate with real email service
    console.log(`Send OTP ${otp} to email ${email}`);
    return { success: true, message: 'OTP sent to email.' };
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
