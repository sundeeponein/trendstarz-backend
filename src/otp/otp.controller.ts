import { Controller, Post, Body } from '@nestjs/common';

@Controller('otp')
export class OtpController {
  @Post('send')
  async sendOtp(@Body() body: any) {
    const { type, value } = body;
    if (!type || !value) {
      return { error: 'Missing type or value' };
    }
    // Simulate sending OTP
    // In real app, generate OTP, save to DB, send via email/SMS
    return { message: `OTP sent to ${type}: ${value}` };
  }

  @Post('verify')
  async verifyOtp(@Body() body: any) {
    const { type, value, otp } = body;
    if (!type || !value || !otp) {
      return { error: 'Missing type, value, or otp' };
    }
    // Simulate OTP verification
    // In real app, check OTP from DB
    if (otp === '123456') {
      return { message: 'OTP verified successfully' };
    }
    return { error: 'Invalid OTP' };
  }
}
