import { Controller, Post, Body, Res } from '@nestjs/common';
import type { Response } from 'express';
import { AuthService } from './auth.service';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('login')
  async login(@Body() body: { email: string; password: string }, @Res() res: Response) {
    const result = await this.authService.login(body.email, body.password);
    return res.status(200).json(result);
  }

  @Post('register-influencer')
  async registerInfluencer(@Body() body: any, @Res() res: Response) {
    const result = await this.authService.registerInfluencer(body);
    return res.status(201).json(result);
  }

  @Post('register-brand')
  async registerBrand(@Body() body: any, @Res() res: Response) {
    const result = await this.authService.registerBrand(body);
    return res.status(201).json(result);
  }

  @Post('send-otp')
  async sendOtp(@Body() body: { email: string }) {
    return this.authService.sendOtp(body.email);
  }

  @Post('verify-otp')
  async verifyOtp(@Body() body: { email: string; otp: string }) {
    return this.authService.verifyOtp(body.email, body.otp);
  }
}
