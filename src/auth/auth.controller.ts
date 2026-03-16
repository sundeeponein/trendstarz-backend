import { Controller, Post, Body, Res, Get, Query } from "@nestjs/common";
import type { Response } from "express";
import { AuthService } from "./auth.service";

@Controller("auth")
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post("login")
  async login(
    @Body() body: { email: string; password: string },
    @Res() res: Response,
  ) {
    const result = await this.authService.login(body.email, body.password);
    return res.status(200).json(result);
  }

  @Post("register-influencer")
  async registerInfluencer(@Body() body: any, @Res() res: Response) {
    const result = await this.authService.registerInfluencer(body);
    return res.status(201).json(result);
  }

  @Post("register-brand")
  async registerBrand(@Body() body: any, @Res() res: Response) {
    const result = await this.authService.registerBrand(body);
    return res.status(201).json(result);
  }

  @Post("send-otp")
  async sendOtp(@Body() body: { email: string }) {
    return this.authService.sendOtp(body.email);
  }

  @Post("send-email-verification")
  async sendEmailVerification(@Body() body: { email: string }) {
    return this.authService.sendEmailVerificationLink(body.email);
  }

  @Get("verify-email")
  async verifyEmail(@Query("token") token: string, @Res() res: Response) {
    try {
      await this.authService.verifyEmailByToken(token);
      const frontend = (
        process.env.FRONTEND_URL || "http://localhost:4200"
      ).replace(/\/$/, "");
      return res.redirect(`${frontend}/verify-email?status=success`);
    } catch {
      const frontend = (
        process.env.FRONTEND_URL || "http://localhost:4200"
      ).replace(/\/$/, "");
      return res.redirect(`${frontend}/verify-email?status=failed`);
    }
  }

  @Post("verify-otp")
  async verifyOtp(@Body() body: { email: string; otp: string }) {
    return this.authService.verifyOtp(body.email, body.otp);
  }
  @Post("forgot-password")
  async forgotPassword(@Body() body: { email: string }, @Res() res: Response) {
    try {
      await this.authService.forgotPassword(body.email);
      return res
        .status(200)
        .json({ message: "Reset email sent if user exists." });
    } catch (err) {
      return res
        .status(400)
        .json({ message: err.message || "Failed to send reset email." });
    }
  }
}
