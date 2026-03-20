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
    try {
      const result = await this.authService.login(body.email, body.password);
      return res.status(200).json(result);
    } catch (err: any) {
      console.error("Auth login error:", err);
      const status = err?.status || 401;
      const message = err?.message || "Login failed";
      return res.status(status).json({ success: false, message });
    }
  }

  @Post("register-influencer")
  async registerInfluencer(@Body() body: any, @Res() res: Response) {
    try {
      const result = await this.authService.registerInfluencer(body);
      return res.status(201).json(result);
    } catch (err: any) {
      console.error("Auth registerInfluencer error:", err);
      const status = err?.status || 400;
      const message = err?.message || "Registration failed";
      return res.status(status).json({ success: false, message });
    }
  }

  @Post("register-brand")
  async registerBrand(@Body() body: any, @Res() res: Response) {
    try {
      const result = await this.authService.registerBrand(body);
      return res.status(201).json(result);
    } catch (err: any) {
      console.error("Auth registerBrand error:", err);
      const status = err?.status || 400;
      const message = err?.message || "Registration failed";
      return res.status(status).json({ success: false, message });
    }
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

  @Post("reset-password")
  async resetPassword(
    @Body() body: { token: string; newPassword: string },
    @Res() res: Response,
  ) {
    try {
      const result = await this.authService.resetPassword(
        body.token,
        body.newPassword,
      );
      return res.status(200).json(result);
    } catch (err) {
      return res
        .status(400)
        .json({ message: err.message || "Failed to reset password." });
    }
  }
}
