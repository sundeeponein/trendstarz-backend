/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return */
import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
} from "@nestjs/common";
import * as bcrypt from "bcryptjs";
import * as jwt from "jsonwebtoken";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import { sendEmail } from "../utils/email";

const otpStore: Record<string, string> = {};

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
    return (
      (await this.userModel.findOne({ email })) ||
      (await this.influencerModel.findOne({ email })) ||
      (await this.brandModel.findOne({ email }))
    );
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
      process.env.JWT_SECRET || "changeme",
      { expiresIn: "1h" },
    );

    const verifyUrl = `${this.getFrontendBaseUrl()}/verify-email?token=${encodeURIComponent(token)}`;
    const html = `
      <p>Hi,</p>
      <p>Please verify your Trendstarz email address by clicking the link below:</p>
      <p><a href="${verifyUrl}">Verify Email</a></p>
      <p>If you did not request this, you can ignore this email.</p>
    `;
    const text = `Please verify your Trendstarz email address: ${verifyUrl}`;

    await sendEmail(normalizedEmail, "Verify your Trendstarz email", text);
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
      decoded = jwt.verify(token, process.env.JWT_SECRET || "changeme");
    } catch {
      throw new BadRequestException("Invalid or expired verification token");
    }

    if (!decoded?.email || decoded?.purpose !== "email_verification") {
      throw new BadRequestException("Invalid verification token payload");
    }

    const user = await this.findAnyUserByEmail(
      String(decoded.email).toLowerCase(),
    );
    if (!user) {
      throw new BadRequestException("User not found for verification token");
    }

    if (!user.isEmailVerified) {
      user.isEmailVerified = true;
      await user.save();
    }

    return { success: true, message: "Email verified successfully." };
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
    // Generate a reset token (for demo, just a random string)
    const resetToken = Math.random().toString(36).substr(2, 10);
    // Save token to user (or a real token store in production)
    user.resetToken = resetToken;
    user.resetTokenExpires = Date.now() + 1000 * 60 * 60; // 1 hour expiry
    await user.save();
    // Send email (use your email util)
    const resetUrl = `${process.env.FRONTEND_URL || "http://localhost:4200"}/reset-password?token=${resetToken}`;
    const text = `Hey ${user.name || user.email},\n\nWe’ve received a request to reset your password for your account. Click the link below to create a new password:\n${resetUrl}\n\nIf you didn’t request to change your password, then don’t worry! Your password is still safe and you can delete this email.`;
    await sendEmail(user.email, "Reset your password", text);
  }
  constructor(
    @InjectModel("User") private readonly userModel: Model<any>,
    @InjectModel("Influencer") private readonly influencerModel: Model<any>,
    @InjectModel("Brand") private readonly brandModel: Model<any>,
    @InjectModel("Category") private readonly categoryModel: Model<any>,
    @InjectModel("State") private readonly stateModel: Model<any>,
    @InjectModel("Language") private readonly languageModel: Model<any>,
    @InjectModel("SocialMedia") private readonly socialMediaModel: Model<any>,
  ) {}

  // Admin login implementation
  async login(email: string, password: string) {
    // Try to find admin user
    const user = await this.userModel.findOne({ email, role: "admin" });
    if (user) {
      const isMatch = await bcrypt.compare(password, user.password);
      if (!isMatch) {
        throw new UnauthorizedException("Invalid credentials");
      }
      // Generate JWT token
      const token = jwt.sign(
        { userId: user._id, email: user.email, role: user.role },
        process.env.JWT_SECRET || "changeme",
        { expiresIn: "7d" },
      );
      return {
        token,
        userType: user.role,
        user: {
          id: user._id,
          name: user.name,
          email: user.email,
          role: user.role,
          profileImage:
            user.profileImages && user.profileImages.length > 0
              ? user.profileImages[0].url
              : null,
        },
      };
    }
    // Check influencer
    const influencer = await this.influencerModel.findOne({ email });
    if (influencer) {
      const isMatch = await bcrypt.compare(password, influencer.password);
      if (!isMatch) {
        throw new UnauthorizedException("Invalid credentials");
      }
      if (influencer.status === "pending") {
        throw new UnauthorizedException(
          "Your account is pending approval. Please wait for admin to activate your account.",
        );
      }
      // Use display name if available, fallback to empty string (never email)
      const displayName =
        influencer.name && influencer.name !== influencer.email
          ? influencer.name
          : "";
      // Use first profile image URL if available
      let profileImageUrl = null;
      if (
        Array.isArray(influencer.profileImages) &&
        influencer.profileImages.length > 0 &&
        influencer.profileImages[0].url
      ) {
        profileImageUrl = influencer.profileImages[0].url;
      }

      // Generate JWT token
      const token = jwt.sign(
        {
          userId: influencer._id,
          email: influencer.email,
          role: "influencer",
          name: displayName,
          profileImage: profileImageUrl,
        },
        process.env.JWT_SECRET || "changeme",
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
        },
      };
    }
    // Check brand
    const brand = await this.brandModel.findOne({ email });
    if (brand) {
      const isMatch = await bcrypt.compare(password, brand.password);
      if (!isMatch) {
        throw new UnauthorizedException("Invalid credentials");
      }
      if (brand.status === "pending") {
        throw new UnauthorizedException(
          "Your account is pending approval. Please wait for admin to activate your account.",
        );
      }
      // Use display name if available, fallback to email
      const displayName = brand.brandName || brand.email;
      // Always return brandLogo as an array of objects (even if empty)
      const brandLogoArr = Array.isArray(brand.brandLogo)
        ? brand.brandLogo
        : [];
      // Generate JWT token with brandLogo as array
      const token = jwt.sign(
        {
          userId: brand._id,
          email: brand.email,
          role: "brand",
          name: displayName,
          brandLogo: brandLogoArr,
        },
        process.env.JWT_SECRET || "changeme",
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
        },
      };
    }
    throw new UnauthorizedException("Invalid credentials");
  }

  async registerInfluencer(data: any) {
    console.log("registerInfluencer called with data:", data);
    // Check duplicates up front so the API can return field-specific 400 messages.
    const [existingEmail, existingUsername, existingPhone] = await Promise.all([
      data.email ? this.influencerModel.findOne({ email: data.email }) : null,
      data.username
        ? this.influencerModel.findOne({ username: data.username })
        : null,
      data.phoneNumber
        ? this.influencerModel.findOne({ phoneNumber: data.phoneNumber })
        : null,
    ]);

    if (existingEmail) {
      throw new BadRequestException("Email already exists");
    }
    if (existingUsername) {
      throw new BadRequestException("Username already exists");
    }
    if (existingPhone) {
      throw new BadRequestException("Phone number already exists");
    }
    // Map category, state, language, and socialMedia platform IDs to names
    const {
      categories = [],
      location = {},
      languages = [],
      socialMedia = [],
    } = data;
    const isObjectId = (val: string) =>
      typeof val === "string" && /^[a-fA-F0-9]{24}$/.test(val);
    // Fetch names for categories
    let categoryNames = [];
    if (categories.length) {
      categoryNames = await Promise.all(
        categories.map(async (val: string) => {
          if (isObjectId(val)) {
            const cat = await this.categoryModel.findById(val);
            return cat ? cat.name : val;
          }
          return val;
        }),
      );
    }
    // Fetch state name
    let stateName = location.state;
    if (stateName) {
      if (isObjectId(stateName)) {
        const stateObj = await this.stateModel.findById(stateName);
        stateName = stateObj ? stateObj.name : stateName;
      }
    }
    // Fetch language names
    let languageNames = [];
    if (languages.length) {
      languageNames = await Promise.all(
        languages.map(async (val: string) => {
          if (isObjectId(val)) {
            const lang = await this.languageModel.findById(val);
            return lang ? lang.name : val;
          }
          return val;
        }),
      );
    }
    // Map socialMedia platform IDs and tier IDs to names
    let socialMediaMapped = [];
    if (socialMedia.length) {
      socialMediaMapped = await Promise.all(
        socialMedia.map(async (sm: any) => {
          let platformName = sm.platform;
          if (platformName && isObjectId(platformName)) {
            const platformObj =
              await this.socialMediaModel.findById(platformName);
            platformName = platformObj ? platformObj.name : platformName;
          }
          const tierName = sm.tier;
          // If you have a Tier model injected, add similar logic here
          // Example:
          // if (tierName && isObjectId(tierName) && this.tierModel) {
          //   const tierObj = await this.tierModel.findById(tierName);
          //   tierName = tierObj ? tierObj.name : tierName;
          // }
          return { ...sm, platform: platformName, tier: tierName };
        }),
      );
    }
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
      if (err.name === "ValidationError") {
        console.error("Influencer validation error:", err.errors);
      } else {
        console.error("Influencer save error:", err);
      }
      throw new BadRequestException(
        "Failed to save influencer: " + err.message,
      );
    }
    return { success: true, message: "Influencer registered", influencer };
  }

  async registerBrand(data: any) {
    // Check if brand already exists
    const existing = await this.brandModel.findOne({ email: data.email });
    if (existing) {
      throw new BadRequestException("Brand already exists");
    }
    // Map category, state, language, and socialMedia platform IDs to names
    const {
      categories = [],
      location = {},
      languages = [],
      socialMedia = [],
    } = data;
    const isObjectId = (val: string) =>
      typeof val === "string" && /^[a-fA-F0-9]{24}$/.test(val);
    // Fetch names for categories
    let categoryNames = [];
    if (categories.length) {
      categoryNames = await Promise.all(
        categories.map(async (val: string) => {
          if (isObjectId(val)) {
            const cat = await this.categoryModel.findById(val);
            return cat ? cat.name : val;
          }
          return val;
        }),
      );
    }
    // Fetch state name
    let stateName = location.state;
    if (stateName) {
      if (isObjectId(stateName)) {
        const stateObj = await this.stateModel.findById(stateName);
        stateName = stateObj ? stateObj.name : stateName;
      }
    }
    // Fetch language names
    let languageNames = [];
    if (languages.length) {
      languageNames = await Promise.all(
        languages.map(async (val: string) => {
          if (isObjectId(val)) {
            const lang = await this.languageModel.findById(val);
            return lang ? lang.name : val;
          }
          return val;
        }),
      );
    }
    // Map socialMedia platform IDs and tier IDs to names
    let socialMediaMapped = [];
    if (socialMedia.length) {
      socialMediaMapped = await Promise.all(
        socialMedia.map(async (sm: any) => {
          let platformName = sm.platform;
          if (platformName && isObjectId(platformName)) {
            const platformObj =
              await this.socialMediaModel.findById(platformName);
            platformName = platformObj ? platformObj.name : platformName;
          }
          const tierName = sm.tier;
          // If you have a Tier model injected, add similar logic here
          // Example:
          // if (tierName && isObjectId(tierName) && this.tierModel) {
          //   const tierObj = await this.tierModel.findById(tierName);
          //   tierName = tierObj ? tierObj.name : tierName;
          // }
          return { ...sm, platform: platformName, tier: tierName };
        }),
      );
    }
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
    const savedBrand = await brand.save();
    try {
      await this.sendEmailVerificationLink(savedBrand.email);
    } catch (verifyMailErr) {
      console.error("Failed to send brand verification email:", verifyMailErr);
    }
    return { success: true, message: "Brand registered", brand: savedBrand };
  }

  async sendOtp(email: string) {
    // Generate OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    otpStore[email] = otp;
    // Send OTP via email
    try {
      await sendEmail(email, "Your OTP Code", `Your OTP code is: ${otp}`);
      return { success: true, message: "OTP sent to email." };
    } catch (err) {
      console.error("Failed to send OTP email:", err);
      throw new BadRequestException("Failed to send OTP email");
    }
  }

  verifyOtp(email: string, otp: string) {
    if (otpStore[email] && otpStore[email] === otp) {
      delete otpStore[email];
      return { success: true, message: "OTP verified." };
    }
    throw new BadRequestException("Invalid OTP");
  }

  async findUserByEmail(email: string) {
    return this.findAnyUserByEmail(email);
  }
}
