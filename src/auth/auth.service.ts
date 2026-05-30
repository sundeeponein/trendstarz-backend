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
import {
  verifyEmailTemplate,
  resetPasswordTemplate,
} from "../email/templates/auth.templates";
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
  private isStrongPassword(password: string): boolean {
    const hasUpper = /[A-Z]/.test(password);
    const hasLower = /[a-z]/.test(password);
    const hasNumber = /[0-9]/.test(password);
    const hasSpecial = /[!@#$%^&*()\-_=+[\]{};:'",.<>/?\\|`~]/.test(password);
    return hasUpper && hasLower && hasNumber && hasSpecial;
  }

  private validatePasswordStrength(password: string): void {
    if (password.length < 8) {
      throw new BadRequestException("Password must be at least 8 characters.");
    }
    if (password.length > 128) {
      throw new BadRequestException("Password must not exceed 128 characters.");
    }
    if (!this.isStrongPassword(password)) {
      throw new BadRequestException(
        "Password must include at least 8 characters, one uppercase letter, one lowercase letter, one number, and one special character.",
      );
    }
  }

  private async findAnyUserByEmail(email: string): Promise<AnyUserDoc | null> {
    // Parallel queries — eliminates sequential round-trips and prevents
    // timing-based user-enumeration across collections.
    const [adminUser, influencer, brand, photographer] = await Promise.all([
      this.userModel.findOne({ email }),
      this.influencerModel.findOne({ email }),
      this.brandModel.findOne({ email }),
      this.photographerModel.findOne({ email }),
    ]);
    return adminUser || influencer || brand || photographer || null;
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

    const backendUrl = (
      process.env.BACKEND_URL || "https://api.trendstarz.in"
    ).replace(/\/$/, "");
    const verifyUrl = `${backendUrl}/api/auth/verify-email?token=${encodeURIComponent(token)}`;
    const { subject, html, text } = verifyEmailTemplate(verifyUrl);

    await sendAppEmail({ to: normalizedEmail, subject, html, text });

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
    const [adminUser, influencer, brand, photographer] = await Promise.all([
      this.userModel.findOne({ email: normalizedEmail }),
      this.influencerModel.findOne({ email: normalizedEmail }),
      this.brandModel.findOne({ email: normalizedEmail }),
      this.photographerModel.findOne({ email: normalizedEmail }),
    ]);

    const user = adminUser || influencer || brand || photographer;
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
      } else if (photographer && !adminUser) {
        const settings = (await this.appSettingsModel
          .findOne({})
          .lean()) as any;
        const mobileOk =
          !settings?.photographerRequireMobileVerified ||
          !!photographer.isMobileVerified;
        if (
          settings?.preApprovePhotographers &&
          mobileOk &&
          photographer.status === "pending"
        ) {
          photographer.status = "accepted";
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
    const normalizedEmail = (email || "").trim().toLowerCase();
    if (!normalizedEmail) {
      throw new BadRequestException("Email is required.");
    }
    // Parallel lookup across all collections — normalized email prevents case-mismatch misses
    const [adminUser, influencer, brand, photographer] = await Promise.all([
      this.userModel.findOne({ email: normalizedEmail }),
      this.influencerModel.findOne({ email: normalizedEmail }),
      this.brandModel.findOne({ email: normalizedEmail }),
      this.photographerModel.findOne({ email: normalizedEmail }),
    ]);
    const user = adminUser || influencer || brand || photographer;
    if (!user) {
      // Silently return — never reveal whether the email is registered (OWASP)
      return;
    }
    // Generate a cryptographically secure reset token
    const resetToken = crypto.randomBytes(32).toString("hex");
    const resetTokenHash = crypto
      .createHash("sha256")
      .update(resetToken)
      .digest("hex");
    user.resetToken = resetTokenHash;
    user.resetTokenExpires = Date.now() + 1000 * 60 * 60; // 1 hour expiry
    await user.save();
    const frontendBase = (
      process.env.FRONTEND_URL || "https://www.trendstarz.in"
    ).replace(/\/$/, "");
    const resetUrl = `${frontendBase}/reset-password?token=${resetToken}`;
    const { subject, html, text } = resetPasswordTemplate(resetUrl);
    await sendAppEmail({ to: user.email, subject, html, text }).catch((err) => {
      console.error("[forgotPassword] Email send failed:", err?.message || err);
    });
  }

  async resetPassword(token: string, newPassword: string) {
    if (!token || !newPassword) {
      throw new BadRequestException("Token and new password are required");
    }
    this.validatePasswordStrength(newPassword);

    // Hash the incoming raw token to compare against the stored hash.
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const now = Date.now();

    // Parallel lookup across collections.
    // Accept both the legacy raw token and the hashed token so existing reset
    // emails continue to work while new tokens are stored hashed.
    const [adminUser, influencer, brand, photographer] = await Promise.all([
      this.userModel.findOne({
        resetToken: { $in: [token, tokenHash] },
        resetTokenExpires: { $gt: now },
      }),
      this.influencerModel.findOne({
        resetToken: { $in: [token, tokenHash] },
        resetTokenExpires: { $gt: now },
      }),
      this.brandModel.findOne({
        resetToken: { $in: [token, tokenHash] },
        resetTokenExpires: { $gt: now },
      }),
      this.photographerModel.findOne({
        resetToken: { $in: [token, tokenHash] },
        resetTokenExpires: { $gt: now },
      }),
    ]);
    const user = adminUser || influencer || brand || photographer;

    if (!user) {
      throw new BadRequestException("Invalid or expired reset token");
    }
    user.password = await bcrypt.hash(newPassword, 10);
    user.resetToken = null;
    user.resetTokenExpires = null;
    await user.save();
    return { success: true, message: "Password reset successfully." };
  }

  async changePassword(
    userId: string,
    role: string,
    currentPassword: string,
    newPassword: string,
    confirmPassword: string,
  ) {
    if (!userId) throw new BadRequestException("User not found.");
    if (!currentPassword) {
      throw new BadRequestException("Existing password is required.");
    }
    if (!newPassword) {
      throw new BadRequestException("New password is required.");
    }
    this.validatePasswordStrength(newPassword);
    if (!confirmPassword) {
      throw new BadRequestException("Confirm password is required.");
    }
    if (newPassword !== confirmPassword) {
      throw new BadRequestException(
        "New password and confirm password do not match.",
      );
    }
    if (newPassword === currentPassword) {
      throw new BadRequestException(
        "New password must be different from existing password.",
      );
    }

    let user: any = null;
    const normalizedRole = String(role || "").toLowerCase();
    if (normalizedRole === "admin") {
      user = await this.userModel.findById(userId);
    } else if (normalizedRole === "influencer") {
      user = await this.influencerModel.findById(userId);
    } else if (normalizedRole === "brand") {
      user = await this.brandModel.findById(userId);
    } else if (normalizedRole === "photographer") {
      user = await this.photographerModel.findById(userId);
    } else {
      const [adminUser, influencer, brand, photographer] = await Promise.all([
        this.userModel.findById(userId),
        this.influencerModel.findById(userId),
        this.brandModel.findById(userId),
        this.photographerModel.findById(userId),
      ]);
      user = adminUser || influencer || brand || photographer;
    }

    if (!user || !user.password) {
      throw new BadRequestException("User not found.");
    }

    const isCurrentValid = await bcrypt.compare(currentPassword, user.password);
    if (!isCurrentValid) {
      throw new BadRequestException("Existing password is incorrect.");
    }

    user.password = await bcrypt.hash(newPassword, 10);
    await user.save();

    return { success: true, message: "Password changed successfully." };
  }

  constructor(
    @InjectModel("User") private readonly userModel: Model<any>,
    @InjectModel("Influencer") private readonly influencerModel: Model<any>,
    @InjectModel("Brand") private readonly brandModel: Model<any>,
    @InjectModel("Photographer") private readonly photographerModel: Model<any>,
    @InjectModel("Category") private readonly categoryModel: Model<any>,
    @InjectModel("State") private readonly stateModel: Model<any>,
    @InjectModel("District") private readonly districtModel: Model<any>,
    @InjectModel("Language") private readonly languageModel: Model<any>,
    @InjectModel("SocialMedia") private readonly socialMediaModel: Model<any>,
    @InjectModel("AppSettings") private readonly appSettingsModel: Model<any>,
  ) {}

  private isObjectId(val: string): boolean {
    return typeof val === "string" && /^[a-fA-F0-9]{24}$/.test(val);
  }

  private async resolveIdsToNames(data: {
    categories?: string[];
    location?: { state?: string; district?: string };
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
    const districtId =
      location.district && this.isObjectId(location.district)
        ? location.district
        : null;

    const [catDocs, langDocs, smDocs, stateDoc, districtDoc] =
      await Promise.all([
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
        districtId ? this.districtModel.findById(districtId).lean() : null,
      ]);

    const catMap = new Map(catDocs.map((d: any) => [String(d._id), d.name]));
    const langMap = new Map(langDocs.map((d: any) => [String(d._id), d.name]));
    const smMap = new Map(smDocs.map((d: any) => [String(d._id), d.name]));

    const categoryNames = categories.map((v) => catMap.get(v) || v);
    const languageNames = languages.map((v) => langMap.get(v) || v);
    const stateName = stateDoc ? (stateDoc as any).name : location.state || "";
    const districtName = districtDoc
      ? (districtDoc as any).name
      : location.district || "";
    const socialMediaMapped = socialMedia.map((sm: any) => ({
      ...sm,
      platform: smMap.get(sm.platform) || sm.platform,
    }));

    return {
      categoryNames,
      languageNames,
      stateName,
      districtName,
      socialMediaMapped,
    };
  }

  // Admin / influencer / brand login
  async login(email: string, password: string) {
    const normalizedEmail = (email || "").trim().toLowerCase();

    // Fetch all collections in parallel to eliminate sequential DB round-trips
    // and prevent timing-based enumeration of which collection a user belongs to.
    const [adminUser, influencer, brandRaw, photographer] = await Promise.all([
      this.userModel.findOne({ email: normalizedEmail, role: "admin" }),
      this.influencerModel.findOne({ email: normalizedEmail }),
      this.brandModel.findOne({ email: normalizedEmail }),
      this.photographerModel.findOne({ email: normalizedEmail }),
    ]);

    // If user is a brand but no brand profile exists, auto-create a minimal profile
    let brand = brandRaw;
    if (!brand && !adminUser && !influencer && !photographer) {
      // Create minimal brand profile
      const minimalBrand = new this.brandModel({
        brandName: normalizedEmail.split("@")[0] || "Brand",
        email: normalizedEmail,
        phoneNumber: "",
        password: await bcrypt.hash(password, 10),
        firstRegisteredAt: new Date(),
        status: "pending",
      });
      try {
        brand = await minimalBrand.save();
      } catch {
        throw new UnauthorizedException(
          "Could not auto-create brand profile for this user.",
        );
      }
    }

    if (adminUser) {
      const isMatch = await bcrypt.compare(password, adminUser.password);
      if (!isMatch) throw new UnauthorizedException("Invalid credentials");
      const now = new Date();
      await this.userModel.updateOne(
        { _id: adminUser._id },
        {
          $set: {
            lastLoginAt: now,
            firstRegisteredAt:
              adminUser.firstRegisteredAt || adminUser.createdAt || now,
          },
        },
      );
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
      const now = new Date();
      await this.influencerModel.updateOne(
        { _id: influencer._id },
        {
          $set: {
            lastLoginAt: now,
            firstRegisteredAt:
              influencer.firstRegisteredAt || influencer.createdAt || now,
          },
        },
      );
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
      // Allow login even if status is pending for auto-created minimal brands
      // (optionally, you can enforce approval here if needed)
      const now = new Date();
      await this.brandModel.updateOne(
        { _id: brand._id },
        {
          $set: {
            lastLoginAt: now,
            firstRegisteredAt:
              brand.firstRegisteredAt || brand.createdAt || now,
          },
        },
      );
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

    if (photographer) {
      const isMatch = await bcrypt.compare(password, photographer.password);
      if (!isMatch) throw new UnauthorizedException("Invalid credentials");
      if (
        photographer.isDeleted === true ||
        photographer.isDeleted === "true"
      ) {
        throw new UnauthorizedException(
          "Your account has been deleted. Please contact support.",
        );
      }
      if (photographer.status === "pending") {
        throw new UnauthorizedException(
          "Your account is pending approval. Please wait for admin to activate your account.",
        );
      }
      const now = new Date();
      await this.photographerModel.updateOne(
        { _id: photographer._id },
        {
          $set: {
            lastLoginAt: now,
            firstRegisteredAt:
              photographer.firstRegisteredAt || photographer.createdAt || now,
          },
        },
      );
      const profileImageUrl =
        Array.isArray(photographer.profileImages) &&
        photographer.profileImages.length > 0 &&
        photographer.profileImages[0].url
          ? photographer.profileImages[0].url
          : null;

      const token = jwt.sign(
        {
          userId: photographer._id,
          email: photographer.email,
          role: "photographer",
        },
        getJwtSecret(),
        { expiresIn: "7d" },
      );
      return {
        token,
        userType: "photographer",
        user: {
          id: photographer._id,
          name: photographer.name || "",
          email: photographer.email,
          role: "photographer",
          profileImage: profileImageUrl,
          isPremium: !!photographer.isPremium,
          premiumEnd: photographer.premiumEnd || null,
        },
      };
    }

    throw new UnauthorizedException("Invalid credentials");
  }

  async registerInfluencer(data: any) {
    if (!data.password || data.password.length < 8) {
      throw new BadRequestException("Password must be at least 8 characters.");
    }
    if (data.confirmPassword && data.password !== data.confirmPassword) {
      throw new BadRequestException("Passwords do not match.");
    }
    // Check duplicates up front so the API can return all conflicting fields together.
    // Email/phone are checked across ALL roles (influencer, brand, admin) so the same
    // contact cannot be reused under a different role.
    const normalizedEmail = data.email
      ? String(data.email).trim().toLowerCase()
      : null;
    const normalizedPhone = data.phoneNumber
      ? String(data.phoneNumber).trim()
      : null;
    // Case-insensitive exact email match — handles legacy records saved with mixed case.
    const emailRegex = normalizedEmail
      ? new RegExp(
          `^${normalizedEmail.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
          "i",
        )
      : null;
    const [
      existingEmailInfluencer,
      existingEmailBrand,
      existingEmailAdmin,
      existingUsername,
      existingPhoneInfluencer,
      existingPhoneBrand,
      existingPhoneAdmin,
    ] = await Promise.all([
      emailRegex ? this.influencerModel.findOne({ email: emailRegex }) : null,
      emailRegex ? this.brandModel.findOne({ email: emailRegex }) : null,
      emailRegex ? this.userModel.findOne({ email: emailRegex }) : null,
      data.username
        ? this.influencerModel.findOne({ username: data.username })
        : null,
      normalizedPhone
        ? this.influencerModel.findOne({ phoneNumber: normalizedPhone })
        : null,
      normalizedPhone
        ? this.brandModel.findOne({ phoneNumber: normalizedPhone })
        : null,
      normalizedPhone
        ? this.userModel.findOne({ phoneNumber: normalizedPhone })
        : null,
    ]);

    const duplicateFields: string[] = [];
    if (existingEmailInfluencer || existingEmailBrand || existingEmailAdmin)
      duplicateFields.push("email");
    if (existingUsername) duplicateFields.push("username");
    if (existingPhoneInfluencer || existingPhoneBrand || existingPhoneAdmin)
      duplicateFields.push("phoneNumber");

    if (duplicateFields.length) {
      throw new BadRequestException({
        message: "Some fields already exist",
        duplicateFields,
      });
    }
    // Map category, state, language, and socialMedia platform IDs to names (batch)
    const {
      categoryNames,
      languageNames,
      stateName,
      districtName,
      socialMediaMapped,
    } = await this.resolveIdsToNames(data);
    // Hash password
    const hashedPassword = await bcrypt.hash(data.password, 10);
    const normalizedProfileImages = Array.isArray(data.profileImages)
      ? data.profileImages
          .filter((img: any) => img?.url && img?.public_id)
          .slice(0, 10)
      : [];

    const signupAttribution = {
      source:
        data?.signupAttribution?.source ||
        data?.source ||
        data?.utm_source ||
        null,
      audience: data?.signupAttribution?.audience || data?.audience || null,
      referrerPath:
        data?.signupAttribution?.referrerPath || data?.referrerPath || null,
      capturedAt: new Date(),
    };

    const verificationDocs = Array.isArray(data?.verificationDocuments)
      ? data.verificationDocuments
          .filter((doc: any) => doc?.url && doc?.public_id)
          .map((doc: any) => ({
            url: String(doc.url),
            public_id: String(doc.public_id),
            originalName: String(doc.originalName || ""),
            mimeType: String(doc.mimeType || ""),
            uploadedAt: new Date(),
          }))
      : [];
    const verificationDisclaimerAccepted =
      data?.verificationDisclaimerAccepted === true;
    const verificationStatus = verificationDocs.length
      ? verificationDisclaimerAccepted
        ? "pending"
        : "not_submitted"
      : "not_submitted";
    const verificationAuditLog = verificationDocs.length
      ? [
          {
            action: "submitted",
            status: verificationStatus,
            note: "Verification documents submitted during registration",
            actorId: "self",
            actorRole: "influencer",
            actedAt: new Date(),
          },
        ]
      : [];

    const influencer = new this.influencerModel({
      ...data,
      email: normalizedEmail || data.email,
      phoneNumber: normalizedPhone || data.phoneNumber,
      password: hashedPassword,
      firstRegisteredAt: new Date(),
      categories: categoryNames,
      location: { state: stateName, district: districtName },
      languages: languageNames,
      socialMedia: socialMediaMapped,
      profileImages: normalizedProfileImages,
      signupAttribution,
      verificationDocuments: verificationDocs,
      verificationDisclaimerAccepted,
      verificationStatus,
      verifiedByTrendStarz: false,
      verificationAdminNotes: "",
      verificationAuditLog,
    });
    // Status stays "pending" until email is verified — auto-approve (if enabled) is applied in verifyEmailByToken.
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
    if (!data.password || data.password.length < 8) {
      throw new BadRequestException("Password must be at least 8 characters.");
    }
    if (data.confirmPassword && data.password !== data.confirmPassword) {
      throw new BadRequestException("Passwords do not match.");
    }
    // Check duplicates up front so the API can return all conflicting fields together.
    const existingBrandUsernameRegex = data.brandUsername
      ? new RegExp(
          `^${String(data.brandUsername).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
          "i",
        )
      : null;

    // Email/phone are checked across ALL roles (influencer, brand, admin) so the same
    // contact cannot be reused under a different role.
    const normalizedEmail = data.email
      ? String(data.email).trim().toLowerCase()
      : null;
    const normalizedPhone = data.phoneNumber
      ? String(data.phoneNumber).trim()
      : null;
    // Case-insensitive exact email match — handles legacy records saved with mixed case.
    const emailRegex = normalizedEmail
      ? new RegExp(
          `^${normalizedEmail.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
          "i",
        )
      : null;
    const [
      existingEmailBrand,
      existingEmailInfluencer,
      existingEmailAdmin,
      existingPhoneBrand,
      existingPhoneInfluencer,
      existingPhoneAdmin,
      existingBrandName,
      existingBrandUsername,
    ] = await Promise.all([
      emailRegex ? this.brandModel.findOne({ email: emailRegex }) : null,
      emailRegex ? this.influencerModel.findOne({ email: emailRegex }) : null,
      emailRegex ? this.userModel.findOne({ email: emailRegex }) : null,
      normalizedPhone
        ? this.brandModel.findOne({ phoneNumber: normalizedPhone })
        : null,
      normalizedPhone
        ? this.influencerModel.findOne({ phoneNumber: normalizedPhone })
        : null,
      normalizedPhone
        ? this.userModel.findOne({ phoneNumber: normalizedPhone })
        : null,
      data.brandName
        ? this.brandModel.findOne({ brandName: data.brandName })
        : null,
      existingBrandUsernameRegex
        ? this.brandModel.findOne({ brandUsername: existingBrandUsernameRegex })
        : null,
    ]);

    const duplicateFields: string[] = [];
    if (existingEmailBrand || existingEmailInfluencer || existingEmailAdmin)
      duplicateFields.push("email");
    if (existingPhoneBrand || existingPhoneInfluencer || existingPhoneAdmin)
      duplicateFields.push("phoneNumber");
    if (existingBrandName) duplicateFields.push("brandName");
    if (existingBrandUsername) duplicateFields.push("brandUsername");

    if (duplicateFields.length) {
      throw new BadRequestException({
        message: "Some fields already exist",
        duplicateFields,
      });
    }
    // Map category, state, language, and socialMedia platform IDs to names (batch)
    const {
      categoryNames,
      languageNames,
      stateName,
      districtName,
      socialMediaMapped,
    } = await this.resolveIdsToNames(data);
    // Hash password
    const hashedPassword = await bcrypt.hash(data.password, 10);
    const signupAttribution = {
      source:
        data?.signupAttribution?.source ||
        data?.source ||
        data?.utm_source ||
        null,
      audience: data?.signupAttribution?.audience || data?.audience || null,
      referrerPath:
        data?.signupAttribution?.referrerPath || data?.referrerPath || null,
      capturedAt: new Date(),
    };
    const brand = new this.brandModel({
      ...data,
      email: normalizedEmail || data.email,
      phoneNumber: normalizedPhone || data.phoneNumber,
      password: hashedPassword,
      firstRegisteredAt: new Date(),
      categories: categoryNames,
      location: { state: stateName, district: districtName },
      languages: languageNames,
      socialMedia: socialMediaMapped,
      signupAttribution,
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

  async registerPhotographer(data: any) {
    if (!data.password || data.password.length < 8) {
      throw new BadRequestException("Password must be at least 8 characters.");
    }
    if (data.confirmPassword && data.password !== data.confirmPassword) {
      throw new BadRequestException("Passwords do not match.");
    }
    this.validatePasswordStrength(data.password);

    const normalizedUsername = data.username
      ? String(data.username).trim().toLowerCase()
      : "";
    if (!normalizedUsername || !/^[a-z0-9_-]+$/.test(normalizedUsername)) {
      throw new BadRequestException(
        "Username is required and can contain only letters, numbers, hyphens and underscores.",
      );
    }

    const normalizedEmail = data.email
      ? String(data.email).trim().toLowerCase()
      : null;
    const normalizedPhone = data.phoneNumber
      ? String(data.phoneNumber).trim()
      : null;
    const emailRegex = normalizedEmail
      ? new RegExp(
          `^${normalizedEmail.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
          "i",
        )
      : null;
    const usernameRegex = new RegExp(
      `^${normalizedUsername.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
      "i",
    );

    // Check email/phone/username uniqueness across all roles
    const [
      existingEmailPhotographer,
      existingEmailInfluencer,
      existingEmailBrand,
      existingEmailAdmin,
      existingPhonePhotographer,
      existingPhoneInfluencer,
      existingPhoneBrand,
      existingUsernamePhotographer,
      existingUsernameInfluencer,
      existingUsernameBrand,
    ] = await Promise.all([
      emailRegex ? this.photographerModel.findOne({ email: emailRegex }) : null,
      emailRegex ? this.influencerModel.findOne({ email: emailRegex }) : null,
      emailRegex ? this.brandModel.findOne({ email: emailRegex }) : null,
      emailRegex ? this.userModel.findOne({ email: emailRegex }) : null,
      normalizedPhone
        ? this.photographerModel.findOne({ phoneNumber: normalizedPhone })
        : null,
      normalizedPhone
        ? this.influencerModel.findOne({ phoneNumber: normalizedPhone })
        : null,
      normalizedPhone
        ? this.brandModel.findOne({ phoneNumber: normalizedPhone })
        : null,
      this.photographerModel.findOne({ username: usernameRegex }),
      this.influencerModel.findOne({ username: usernameRegex }),
      this.brandModel.findOne({ brandUsername: usernameRegex }),
    ]);

    const duplicateFields: string[] = [];
    if (
      existingEmailPhotographer ||
      existingEmailInfluencer ||
      existingEmailBrand ||
      existingEmailAdmin
    )
      duplicateFields.push("email");
    if (
      existingPhonePhotographer ||
      existingPhoneInfluencer ||
      existingPhoneBrand
    )
      duplicateFields.push("phoneNumber");
    if (
      existingUsernamePhotographer ||
      existingUsernameInfluencer ||
      existingUsernameBrand
    )
      duplicateFields.push("username");

    if (duplicateFields.length) {
      throw new BadRequestException({
        message: "Some fields already exist",
        duplicateFields,
      });
    }

    // Resolve state/district IDs to names if IDs were provided
    const stateId =
      data?.location?.state && this.isObjectId(data.location.state)
        ? data.location.state
        : null;
    const districtId =
      data?.location?.district && this.isObjectId(data.location.district)
        ? data.location.district
        : null;
    const [stateDoc, districtDoc] = await Promise.all([
      stateId ? this.stateModel.findById(stateId).lean() : null,
      districtId ? this.districtModel.findById(districtId).lean() : null,
    ]);
    const stateName = stateDoc
      ? (stateDoc as any).name
      : data?.location?.state || "";
    const districtName = districtDoc
      ? (districtDoc as any).name
      : data?.location?.district || "";

    const hashedPassword = await bcrypt.hash(data.password, 10);
    const normalizedProfileImages = Array.isArray(data.profileImages)
      ? data.profileImages
          .filter((img: any) => img?.url && img?.public_id)
          .slice(0, 10)
      : [];

    const signupAttribution = {
      source:
        data?.signupAttribution?.source ||
        data?.source ||
        data?.utm_source ||
        null,
      audience: data?.signupAttribution?.audience || data?.audience || null,
      referrerPath:
        data?.signupAttribution?.referrerPath || data?.referrerPath || null,
      capturedAt: new Date(),
    };

    const photographer = new this.photographerModel({
      ...data,
      username: normalizedUsername,
      email: normalizedEmail || data.email,
      phoneNumber: normalizedPhone || data.phoneNumber,
      password: hashedPassword,
      firstRegisteredAt: new Date(),
      location: { state: stateName, district: districtName },
      profileImages: normalizedProfileImages,
      signupAttribution,
    });

    try {
      const saved = await photographer.save();
      void this.sendEmailVerificationLink(saved.email).catch(
        (verifyMailErr) => {
          console.error(
            "Failed to send photographer verification email:",
            verifyMailErr,
          );
        },
      );
      return {
        success: true,
        message: "Photographer registered",
        photographer: saved,
      };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error("Photographer save error:", err);
      throw new BadRequestException(
        "Failed to save photographer: " + error.message,
      );
    }
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
      platformFeeEnabled: !!settings?.platformFeeEnabled,
      platformFeePercent: settings?.platformFeePercent ?? 10,
      platformCommissionPercent: settings?.platformCommissionPercent ?? 12,
      inviteUnlockFee: settings?.inviteUnlockFee ?? 499,
      minimumCampaignFee: settings?.minimumCampaignFee ?? 1000,
      gstPercent: settings?.gstPercent ?? 18,
      // Campaign payment UPI shown to brands on the payment screen
      paymentUpiId: settings?.paymentUpiId || "trendstarzin@kotak",
      showSearchLink: settings?.showSearchLink !== false,
      showRegisterInfluencerLink:
        settings?.showRegisterInfluencerLink !== false,
      showRegisterBrandLink: settings?.showRegisterBrandLink !== false,
      showRegisterPhotographerLink:
        settings?.showRegisterPhotographerLink !== false,
    };
  }

  async findUserByEmail(email: string) {
    return this.findAnyUserByEmail(email);
  }
}
