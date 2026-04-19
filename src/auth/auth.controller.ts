import { Controller, Post, Body, Res, Get, Query, UsePipes, ValidationPipe, HttpCode } from "@nestjs/common";
import type { Response } from "express";
import { AuthService } from "./auth.service";
import {
  LoginDto,
  ForgotPasswordDto,
  ResetPasswordDto,
  SendEmailVerificationDto,
} from "./dto/auth.dto";

@Controller("auth")
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  private formatRegistrationError(err: any, fallbackMessage: string) {
    const status = err?.status || 400;
    const response = typeof err?.getResponse === "function" ? err.getResponse() : err?.response;

    if (response && typeof response === "object") {
      const message = (response as any).message ?? err?.message ?? fallbackMessage;
      const duplicateFields = (response as any).duplicateFields;
      return {
        status,
        body: {
          success: false,
          message,
          ...(Array.isArray(duplicateFields) ? { duplicateFields } : {}),
        },
      };
    }

    return {
      status,
      body: { success: false, message: err?.message || fallbackMessage },
    };
  }

  @Post("login")
  @HttpCode(200)
  @UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
  async login(@Body() body: LoginDto, @Res() res: Response) {
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

  @Get("app-settings")
  async getAppSettings() {
    return this.authService.getPublicSettings();
  }

  @Post("register-influencer")
  async registerInfluencer(@Body() body: any, @Res() res: Response) {
    try {
      const result = await this.authService.registerInfluencer(body);
      return res.status(201).json(result);
    } catch (err: any) {
      console.error("Auth registerInfluencer error:", err);
      const formatted = this.formatRegistrationError(err, "Registration failed");
      return res.status(formatted.status).json(formatted.body);
    }
  }

  @Post("register-brand")
  async registerBrand(@Body() body: any, @Res() res: Response) {
    try {
      const result = await this.authService.registerBrand(body);
      return res.status(201).json(result);
    } catch (err: any) {
      console.error("Auth registerBrand error:", err);
      const formatted = this.formatRegistrationError(err, "Registration failed");
      return res.status(formatted.status).json(formatted.body);
    }
  }

  @Post("send-email-verification")
  @UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
  async sendEmailVerification(@Body() body: SendEmailVerificationDto) {
    return this.authService.sendEmailVerificationLink(body.email);
  }

  @Get("verify-email")
  async verifyEmail(@Query("token") token: string, @Res() res: Response) {
    try {
      const result = await this.authService.verifyEmailByToken(token);
      const frontend = (
        process.env.FRONTEND_URL || "http://localhost:4200"
      ).replace(/\/$/, "");
      const approved = result?.autoApproved ? "&approved=true" : "";
      return res.redirect(`${frontend}/verify-email?status=success${approved}`);
    } catch {
      const frontend = (
        process.env.FRONTEND_URL || "http://localhost:4200"
      ).replace(/\/$/, "");
      return res.redirect(`${frontend}/verify-email?status=failed`);
    }
  }

  @Post("forgot-password")
  @HttpCode(200)
  @UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
  async forgotPassword(@Body() body: ForgotPasswordDto, @Res() res: Response) {
    try {
      await this.authService.forgotPassword(body.email);
      // Always return the same response — never reveal whether the email exists.
      return res
        .status(200)
        .json({ message: "If that email is registered, a reset link has been sent." });
    } catch (err) {
      return res
        .status(400)
        .json({ message: err.message || "Failed to send reset email." });
    }
  }

  @Post("reset-password")
  @UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
  async resetPassword(
    @Body() body: ResetPasswordDto,
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
