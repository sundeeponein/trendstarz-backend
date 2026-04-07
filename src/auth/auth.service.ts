import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
} from "@nestjs/common";
import * as bcrypt from "bcryptjs";
import * as crypto from "crypto";
import * as jwt from "jsonwebtoken";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import { sendAppEmail } from "../utils/app-email.service";
import { getJwtSecret } from "./jwt-secret";

type AnyUserDoc = {
  email: string;
  name?: string;
  isEmailVerified?: boolean;
  resetToken?: string;
  resetTokenExpires?: number;
  save: () => Promise<unknown>;
  [key: string]: unknown;
};

@Injectable()
export class AuthService {
  private getFrontendBaseUrl(): string {
    return (process.env.FRONTEND_URL || "http://localhost:4200").replace(
      /\/$/,
      "",
    );
  }

  private async findAnyUserByEmail(email: string): Promise<AnyUserDoc | null> {
    // Parallel queries — eliminates sequential round-trips and prevents
    // timing-based user-enumeration across collections.
    const [adminUser, influencer, brand] = await Promise.all([
      this.userModel.findOne({ email }),
      this.influencerModel.findOne({ email }),
      this.brandModel.findOne({ email }),
    ]);
    return adminUser || influencer || brand || null;
  }

  async sendEmailVerificationLink(email: string) {
    const normalizedEmail = (email || "").trim().toLowerCase();
    if (!normalizedEmail) {
      throw new BadRequestException("Email is required");
    }

    const user = await this.findAnyUserByEmail(normalizedEmail);
    if (!user) {
      // Avoid exposing user existence details.
      return {
        success: true,
        message: "If the email exists, a verification link has been sent.",
      };
    }

    if (user.isEmailVerified) {
      return { success: true, message: "Email is already verified." };
    }

    const token = jwt.sign(
      { email: normalizedEmail, purpose: "email_verification" },
      getJwtSecret(),
      { expiresIn: "1h" },
    );

    const backendUrl = process.env.BACKEND_URL || "http://localhost:3000";
    const verifyUrl = `${backendUrl}/api/auth/verify-email?token=${encodeURIComponent(token)}`;
    const html = `
      <p>Hi,</p>
      <p>Please verify your Trendstarz email address by clicking the link below:</p>
      <p><a href="${verifyUrl}">Verify Email</a></p>
      <p>If you did not request this, you can ignore this email.</p>
    `;
    const text = `Please verify your Trendstarz email address: ${verifyUrl}`;

    await sendAppEmail({
      to: normalizedEmail,
      subject: "Verify your Trendstarz email",
      text,
      html,
    });
    // Keep html for future providers that support rich templates.
    void html;

    return { success: true, message: "Verification email sent." };
  }

  async verifyEmailByToken(token: string) {
    if (!token) {
      throw new BadRequestException("Missing verification token");
    }

    let decoded: any;
    try {
      decoded = jwt.verify(token, getJwtSecret());
    } catch {
      throw new BadRequestException("Invalid or expired verification token");
    }

    if (!decoded?.email || decoded?.purpose !== "email_verification") {
      throw new BadRequestException("Invalid verification token payload");
    }

    const normalizedEmail = String(decoded.email).toLowerCase();

    // Parallel lookup — we need to know the user TYPE to apply the correct pre-approve setting.
    const [adminUser, influencer, brand] = await Promise.all([
      this.userModel.findOne({ email: normalizedEmail }),
      this.influencerModel.findOne({ email: normalizedEmail }),
      this.brandModel.findOne({ email: normalizedEmail }),
    ]);

    const user = adminUser || influencer || brand;
    if (!user) {
      throw new BadRequestException("User not found for verification token");
    }

    if (!user.isEmailVerified) {
      user.isEmailVerified = true;
      let autoApproved = false;

      // Auto-approve only after email is verified (secure: not at registration time).
      // The email condition is inherently satisfied here (we just verified it).
      // Mobile condition gates approval until mobile verification is also done (future feature).
      if (influencer && !adminUser) {
        const settings = (await this.appSettingsModel
          .findOne({})
          .lean()) as any;
        const mobileOk =
          !settings?.influencerRequireMobileVerified ||
          !!influencer.isMobileVerified;
        if (
          settings?.preApproveInfluencers &&
          mobileOk &&
          influencer.status === "pending"
        ) {
          influencer.status = "accepted";
          autoApproved = true;
        }
      } else if (brand && !adminUser) {
        const settings = (await this.appSettingsModel
          .findOne({})
          .lean()) as any;
        const mobileOk =
          !settings?.brandRequireMobileVerified || !!brand.isMobileVerified;
        if (
          settings?.preApproveBrands &&
          mobileOk &&
          brand.status === "pending"
        ) {
          brand.status = "accepted";
          autoApproved = true;
        }
      }

      await user.save();
      return {
        success: true,
        autoApproved,
        message: "Email verified successfully.",
      };
    }

    return {
      success: true,
      autoApproved: false,
      message: "Email already verified.",
    };
  }

  async forgotPassword(email: string) {
    // Try to find user in all collections
    const user =
      (await this.userModel.findOne({ email })) ||
      (await this.influencerModel.findOne({ email })) ||
      (await this.brandModel.findOne({ email }));
    if (!user) {
      throw new Error("Email not found. Please enter a registered email.");
    }
    // Generate a cryptographically secure reset token
    const resetToken = crypto.randomBytes(32).toString("hex");
    // Save token to user (or a real token store in production)
    user.resetToken = resetToken;
    user.resetTokenExpires = Date.now() + 1000 * 60 * 60; // 1 hour expiry
    await user.save();
    // Send email (use your email util)
    const resetUrl = `${process.env.FRONTEND_URL || "http://localhost:4200"}/reset-password?token=${resetToken}`;
    const text = `Reset your Trendstarz password: ${resetUrl}`;
    await sendAppEmail({
      to: user.email,
      subject: "Reset your password",
      text,
    });
  }

  async resetPassword(token: string, newPassword: string) {
    if (!token || !newPassword) {
      throw new BadRequestException("Token and new password are required");
    }
    if (newPassword.length < 8) {
      throw new BadRequestException("Password must be at least 8 characters.");
    }
    if (newPassword.length > 128) {
      throw new BadRequestException("Password must not exceed 128 characters.");
    }

    // Hash the incoming raw token to compare against the stored hash.
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const now = Date.now();

    // Parallel lookup across collections.
    const [adminUser, influencer, brand] = await Promise.all([
      this.userModel.findOne({
        resetToken: tokenHash,
        resetTokenExpires: { $gt: now },
      }),
      this.influencerModel.findOne({
        resetToken: tokenHash,
        resetTokenExpires: { $gt: now },
      }),
      this.brandModel.findOne({
        resetToken: tokenHash,
        resetTokenExpires: { $gt: now },
      }),
    ]);
    const user = adminUser || influencer || brand;

    if (!user) {
      throw new BadRequestException("Invalid or expired reset token");
    }
    user.password = await bcrypt.hash(newPassword, 10);
    user.resetToken = null;
    user.resetTokenExpires = null;
    await user.save();
    return { success: true, message: "Password reset successfully." };
  }

  constructor(
    @InjectModel("User") private readonly userModel: Model<any>,
    @InjectModel("Influencer") private readonly influencerModel: Model<any>,
    @InjectModel("Brand") private readonly brandModel: Model<any>,
    @InjectModel("Category") private readonly categoryModel: Model<any>,
    @InjectModel("State") private readonly stateModel: Model<any>,
    @InjectModel("Language") private readonly languageModel: Model<any>,
    @InjectModel("SocialMedia") private readonly socialMediaModel: Model<any>,
    @InjectModel("AppSettings") private readonly appSettingsModel: Model<any>,
  ) {}

  private isObjectId(val: string): boolean {
    return typeof val === "string" && /^[a-fA-F0-9]{24}$/.test(val);
  }

  private async resolveIdsToNames(data: {
    categories?: string[];
    location?: { state?: string };
    languages?: string[];
    socialMedia?: any[];
  }) {
    const {
      categories = [],
      location = {},
      languages = [],
      socialMedia = [],
    } = data;

    // Batch fetch all IDs at once
    const catIds = categories.filter((v) => this.isObjectId(v));
    const langIds = languages.filter((v) => this.isObjectId(v));
    const smIds = socialMedia
      .map((sm) => sm.platform)
      .filter((v: string) => v && this.isObjectId(v));
    const stateId =
      location.state && this.isObjectId(location.state) ? location.state : null;

    const [catDocs, langDocs, smDocs, stateDoc] = await Promise.all([
      catIds.length
        ? this.categoryModel.find({ _id: { $in: catIds } }).lean()
        : [],
      langIds.length
        ? this.languageModel.find({ _id: { $in: langIds } }).lean()
        : [],
      smIds.length
        ? this.socialMediaModel.find({ _id: { $in: smIds } }).lean()
        : [],
      stateId ? this.stateModel.findById(stateId).lean() : null,
    ]);

    const catMap = new Map(catDocs.map((d: any) => [String(d._id), d.name]));
    const langMap = new Map(langDocs.map((d: any) => [String(d._id), d.name]));
    const smMap = new Map(smDocs.map((d: any) => [String(d._id), d.name]));

    const categoryNames = categories.map((v) => catMap.get(v) || v);
    const languageNames = languages.map((v) => langMap.get(v) || v);
    const stateName = stateDoc ? (stateDoc as any).name : location.state || "";
    const socialMediaMapped = socialMedia.map((sm: any) => ({
      ...sm,
      platform: smMap.get(sm.platform) || sm.platform,
    }));

    return { categoryNames, languageNames, stateName, socialMediaMapped };
  }

  // Admin / influencer / brand login
  async login(email: string, password: string) {
    const normalizedEmail = (email || "").trim().toLowerCase();

    // Fetch all three collections in parallel to eliminate sequential DB round-trips
    // and prevent timing-based enumeration of which collection a user belongs to.
    const [adminUser, influencer, brand] = await Promise.all([
      this.userModel.findOne({ email: normalizedEmail, role: "admin" }),
      this.influencerModel.findOne({ email: normalizedEmail }),
      this.brandModel.findOne({ email: normalizedEmail }),
    ]);

    if (adminUser) {
      const isMatch = await bcrypt.compare(password, adminUser.password);
      if (!isMatch) throw new UnauthorizedException("Invalid credentials");
      const token = jwt.sign(
        { userId: adminUser._id, email: adminUser.email, role: adminUser.role },
        getJwtSecret(),
        { expiresIn: "7d" },
      );
      return {
        token,
        userType: adminUser.role,
        user: {
          id: adminUser._id,
          name: adminUser.name,
          email: adminUser.email,
          role: adminUser.role,
          profileImage:
            Array.isArray(adminUser.profileImages) &&
            adminUser.profileImages.length > 0
              ? adminUser.profileImages[0].url
              : null,
        },
      };
    }

    if (influencer) {
      const isMatch = await bcrypt.compare(password, influencer.password);
      if (!isMatch) throw new UnauthorizedException("Invalid credentials");
      if (influencer.isDeleted === true || influencer.isDeleted === "true") {
        throw new UnauthorizedException(
          "Your account has been deleted. Please contact support.",
        );
      }
      if (influencer.status === "pending") {
        throw new UnauthorizedException(
          "Your account is pending approval. Please wait for admin to activate your account.",
        );
      }
      const displayName =
        influencer.name && influencer.name !== influencer.email
          ? influencer.name
          : "";
      const profileImageUrl =
        Array.isArray(influencer.profileImages) &&
        influencer.profileImages.length > 0 &&
        influencer.profileImages[0].url
          ? influencer.profileImages[0].url
          : null;

      // Keep JWT payload minimal — no PII beyond userId/email/role.
      const token = jwt.sign(
        { userId: influencer._id, email: influencer.email, role: "influencer" },
        getJwtSecret(),
        { expiresIn: "7d" },
      );
      return {
        token,
        userType: "influencer",
        user: {
          id: influencer._id,
          name: displayName,
          email: influencer.email,
          role: "influencer",
          profileImage: profileImageUrl,
          isPremium: !!influencer.isPremium,
          premiumEnd: influencer.premiumEnd || null,
        },
      };
    }

    if (brand) {
      const isMatch = await bcrypt.compare(password, brand.password);
      if (!isMatch) throw new UnauthorizedException("Invalid credentials");
      if (brand.isDeleted === true || brand.isDeleted === "true") {
        throw new UnauthorizedException(
          "Your account has been deleted. Please contact support.",
        );
      }
      if (brand.status === "pending") {
        throw new UnauthorizedException(
          "Your account is pending approval. Please wait for admin to activate your account.",
        );
      }
      const displayName = brand.brandName || brand.email;
      const brandLogoArr = Array.isArray(brand.brandLogo)
        ? brand.brandLogo
        : [];

      // Keep JWT payload minimal — no PII beyond userId/email/role.
      const token = jwt.sign(
        { userId: brand._id, email: brand.email, role: "brand" },
        getJwtSecret(),
        { expiresIn: "7d" },
      );
      return {
        token,
        userType: "brand",
        user: {
          id: brand._id,
          name: displayName,
          email: brand.email,
          role: "brand",
          brandLogo: brandLogoArr,
          isPremium: !!brand.isPremium,
          premiumEnd: brand.premiumEnd || null,
        },
      };
    }

    throw new UnauthorizedException("Invalid credentials");
  }

  async registerInfluencer(data: any) {
    console.log("registerInfluencer called with data:", data);
    // Check duplicates up front so the API can return all conflicting fields together.
    const [existingEmail, existingUsername, existingPhone] = await Promise.all([
      data.email ? this.influencerModel.findOne({ email: data.email }) : null,
      data.username
        ? this.influencerModel.findOne({ username: data.username })
        : null,
      data.phoneNumber
        ? this.influencerModel.findOne({ phoneNumber: data.phoneNumber })
        : null,
    ]);

    const duplicateFields: string[] = [];
    if (existingEmail) duplicateFields.push("email");
    if (existingUsername) duplicateFields.push("username");
    if (existingPhone) duplicateFields.push("phoneNumber");

    if (duplicateFields.length) {
      throw new BadRequestException({
        message: "Some fields already exist",
        duplicateFields,
      });
    }
    // Map category, state, language, and socialMedia platform IDs to names (batch)
    const { categoryNames, languageNames, stateName, socialMediaMapped } =
      await this.resolveIdsToNames(data);
    // Hash password
    const hashedPassword = await bcrypt.hash(data.password, 10);
    const normalizedProfileImages = Array.isArray(data.profileImages)
      ? data.profileImages
          .filter((img: any) => img?.url && img?.public_id)
          .slice(0, 1)
      : [];

    const influencer = new this.influencerModel({
      ...data,
      password: hashedPassword,
      categories: categoryNames,
      location: { state: stateName },
      languages: languageNames,
      socialMedia: socialMediaMapped,
      profileImages: normalizedProfileImages,
    });
    // Status stays "pending" until email is verified — auto-approve (if enabled) is applied in verifyEmailByToken.
    console.log("Influencer payload:", influencer);
    try {
      const saved = await influencer.save();
      try {
        await this.sendEmailVerificationLink(saved.email);
      } catch (verifyMailErr) {
        console.error(
          "Failed to send influencer verification email:",
          verifyMailErr,
        );
      }
      console.log(
        "Influencer saved successfully:",
        saved._id,
        "Collection:",
        saved.collection.name,
      );
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      const mongoErr = err as { name?: string; errors?: unknown };
      if (mongoErr?.name === "ValidationError") {
        console.error("Influencer validation error:", mongoErr.errors);
      } else {
        console.error("Influencer save error:", err);
      }
      throw new BadRequestException(
        "Failed to save influencer: " + error.message,
      );
    }
    return { success: true, message: "Influencer registered", influencer };
  }

  async registerBrand(data: any) {
    // Check duplicates up front so the API can return all conflicting fields together.
    const existingBrandUsernameRegex = data.brandUsername
      ? new RegExp(
          `^${String(data.brandUsername).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
          "i",
        )
      : null;

    const [
      existingEmail,
      existingPhone,
      existingBrandName,
      existingBrandUsername,
    ] = await Promise.all([
      data.email ? this.brandModel.findOne({ email: data.email }) : null,
      data.phoneNumber
        ? this.brandModel.findOne({ phoneNumber: data.phoneNumber })
        : null,
      data.brandName
        ? this.brandModel.findOne({ brandName: data.brandName })
        : null,
      existingBrandUsernameRegex
        ? this.brandModel.findOne({ brandUsername: existingBrandUsernameRegex })
        : null,
    ]);

    const duplicateFields: string[] = [];
    if (existingEmail) duplicateFields.push("email");
    if (existingPhone) duplicateFields.push("phoneNumber");
    if (existingBrandName) duplicateFields.push("brandName");
    if (existingBrandUsername) duplicateFields.push("brandUsername");

    if (duplicateFields.length) {
      throw new BadRequestException({
        message: "Some fields already exist",
        duplicateFields,
      });
    }
    // Map category, state, language, and socialMedia platform IDs to names (batch)
    const { categoryNames, languageNames, stateName, socialMediaMapped } =
      await this.resolveIdsToNames(data);
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
    // Status stays "pending" until email is verified — auto-approve (if enabled) is applied in verifyEmailByToken.
    const savedBrand = await brand.save();
    try {
      await this.sendEmailVerificationLink(savedBrand.email);
    } catch (verifyMailErr) {
      console.error("Failed to send brand verification email:", verifyMailErr);
    }
    return { success: true, message: "Brand registered", brand: savedBrand };
  }

  async getPublicSettings() {
    const settings = (await this.appSettingsModel.findOne({}).lean()) as any;
    return {
      preApproveInfluencers: !!settings?.preApproveInfluencers,
      influencerRequireEmailVerified:
        settings?.influencerRequireEmailVerified !== false,
      influencerRequireMobileVerified:
        !!settings?.influencerRequireMobileVerified,
      preApproveBrands: !!settings?.preApproveBrands,
      brandRequireEmailVerified: settings?.brandRequireEmailVerified !== false,
      brandRequireMobileVerified: !!settings?.brandRequireMobileVerified,
    };
  }

  async findUserByEmail(email: string) {
    return this.findAnyUserByEmail(email);
  }
}
