import {
  Controller,
  Post,
  Body,
  Res,
  Get,
  Query,
  UsePipes,
  ValidationPipe,
  HttpCode,
  UseInterceptors,
  UploadedFile,
  UseGuards,
  Req,
  BadRequestException,
} from "@nestjs/common";
import type { Response } from "express";
import { FileInterceptor } from "@nestjs/platform-express";
import { diskStorage } from "multer";
import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import { AuthService } from "./auth.service";
import { CloudinaryService } from "../cloudinary.service";
import { JwtAuthGuard } from "./jwt-auth.guard";
import { Throttle } from "@nestjs/throttler";
import {
  LoginDto,
  ForgotPasswordDto,
  ResetPasswordDto,
  SendEmailVerificationDto,
  ChangePasswordDto,
} from "./dto/auth.dto";

@Controller("auth")
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly cloudinaryService: CloudinaryService,
  ) {}

  private resolveFrontendBase(host?: string) {
    const configured = (process.env.FRONTEND_URL || "").trim();
    if (configured) return configured.replace(/\/$/, "");

    const hostLc = String(host || "").toLowerCase();
    const isLocal =
      hostLc.includes("localhost") || hostLc.includes("127.0.0.1");

    return (isLocal ? "http://localhost:4200" : "https://trendstarz.in").replace(
      /\/$/,
      "",
    );
  }

  private formatRegistrationError(err: any, fallbackMessage: string) {
    const status = err?.status || 400;
    const response =
      typeof err?.getResponse === "function"
        ? err.getResponse()
        : err?.response;

    if (response && typeof response === "object") {
      const message = response.message ?? err?.message ?? fallbackMessage;
      const duplicateFields = response.duplicateFields;
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
  @Throttle({ default: { ttl: 60000, limit: 5 } })
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
  @Throttle({ default: { ttl: 60000, limit: 3 } })
  async registerInfluencer(@Body() body: any, @Res() res: Response) {
    try {
      const result = await this.authService.registerInfluencer(body);
      return res.status(201).json(result);
    } catch (err: any) {
      console.error("Auth registerInfluencer error:", err);
      const formatted = this.formatRegistrationError(
        err,
        "Registration failed",
      );
      return res.status(formatted.status).json(formatted.body);
    }
  }

  @Post("register-brand")
  @Throttle({ default: { ttl: 60000, limit: 3 } })
  async registerBrand(@Body() body: any, @Res() res: Response) {
    try {
      const result = await this.authService.registerBrand(body);
      return res.status(201).json(result);
    } catch (err: any) {
      console.error("Auth registerBrand error:", err);
      const formatted = this.formatRegistrationError(
        err,
        "Registration failed",
      );
      return res.status(formatted.status).json(formatted.body);
    }
  }

  @Post("upload-image")
  @UseInterceptors(
    FileInterceptor("file", {
      storage: diskStorage({
        destination: (req: any, file: any, cb: any) => {
          const dest = path.resolve(process.cwd(), "assets/local-images");
          if (!fs.existsSync(dest)) {
            fs.mkdirSync(dest, { recursive: true });
          }
          cb(null, dest);
        },
        filename: (req: any, file: any, cb: any) => {
          const ext = path.extname(file.originalname || "") || ".jpg";
          cb(null, `${randomUUID()}${ext}`);
        },
      }),
    }),
  )
  async uploadImage(
    @UploadedFile() file: Express.Multer.File,
    @Body("folder") folder?: string,
  ) {
    const targetFolder =
      typeof folder === "string" && /^[a-zA-Z0-9_-]+$/.test(folder)
        ? folder
        : "registration_images";

    const uploaded = await this.cloudinaryService.uploadImage(
      file.path,
      targetFolder,
    );

    if (file?.path && fs.existsSync(file.path)) {
      fs.unlinkSync(file.path);
    }

    return {
      url: uploaded.secure_url || uploaded.url,
      public_id: uploaded.public_id,
    };
  }

  @Post("upload-verification")
  @UseInterceptors(
    FileInterceptor("file", {
      storage: diskStorage({
        destination: (req: any, file: any, cb: any) => {
          const dest = path.resolve(process.cwd(), "assets/local-images");
          if (!fs.existsSync(dest)) {
            fs.mkdirSync(dest, { recursive: true });
          }
          cb(null, dest);
        },
        filename: (req: any, file: any, cb: any) => {
          const ext = path.extname(file.originalname || "") || ".pdf";
          cb(null, `${randomUUID()}${ext}`);
        },
      }),
      fileFilter: (req, file, cb) => {
        const allowed = ["application/pdf", "image/jpeg", "image/png"];
        if (!allowed.includes(file.mimetype)) {
          return cb(
            new BadRequestException("Only PDF, JPG, PNG files are allowed"),
            false,
          );
        }
        cb(null, true);
      },
      limits: { fileSize: 10 * 1024 * 1024 },
    }),
  )
  async uploadVerification(@UploadedFile() file: Express.Multer.File) {
    const uploaded = await this.cloudinaryService.uploadFile(
      file.path,
      "influencer-verifications",
      "auto",
    );

    if (file?.path && fs.existsSync(file.path)) {
      fs.unlinkSync(file.path);
    }

    return {
      url: uploaded.secure_url || uploaded.url,
      public_id: uploaded.public_id,
      mimeType: file?.mimetype || "",
      originalName: file?.originalname || "",
    };
  }

  @Post("send-email-verification")
  @UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
  async sendEmailVerification(@Body() body: SendEmailVerificationDto) {
    return this.authService.sendEmailVerificationLink(body.email);
  }

  @Get("verify-email")
  async verifyEmail(
    @Query("token") token: string,
    @Req() req: any,
    @Res() res: Response,
  ) {
    const frontendBase = this.resolveFrontendBase(req?.get?.("host"));

    try {
      const result = await this.authService.verifyEmailByToken(token);
      const approved = result?.autoApproved ? "&approved=true" : "";
      return res.redirect(
        `${frontendBase}/verify-email?status=success${approved}`,
      );
    } catch {
      return res.redirect(`${frontendBase}/verify-email?status=failed`);
    }
  }

  @Post("forgot-password")
  @Throttle({ default: { ttl: 60000, limit: 3 } })
  @HttpCode(200)
  @UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
  async forgotPassword(@Body() body: ForgotPasswordDto, @Res() res: Response) {
    try {
      await this.authService.forgotPassword(body.email);
      // Always return the same response — never reveal whether the email exists.
      return res.status(200).json({
        message: "If that email is registered, a reset link has been sent.",
      });
    } catch (err: any) {
      return res
        .status(400)
        .json({ message: err.message || "Failed to send reset email." });
    }
  }

  @Post("reset-password")
  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
  async resetPassword(@Body() body: ResetPasswordDto, @Res() res: Response) {
    try {
      const result = await this.authService.resetPassword(
        body.token,
        body.newPassword,
      );
      return res.status(200).json(result);
    } catch (err: any) {
      return res
        .status(400)
        .json({ message: err.message || "Failed to reset password." });
    }
  }

  @Post("change-password")
  @UseGuards(JwtAuthGuard)
  @UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
  async changePassword(
    @Req() req: any,
    @Body() body: ChangePasswordDto,
    @Res() res: Response,
  ) {
    try {
      const userId = req?.user?.userId || req?.user?.sub || req?.user?.id;
      const role = req?.user?.role;
      const result = await this.authService.changePassword(
        String(userId || ""),
        String(role || ""),
        body.currentPassword,
        body.newPassword,
        body.confirmPassword,
      );
      return res.status(200).json(result);
    } catch (err: any) {
      return res
        .status(400)
        .json({ message: err.message || "Failed to change password." });
    }
  }
}
