import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
  ForbiddenException,
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
import { normalizeCollaborationAvailability } from "../utils/collaboration-availability.util";
import {
  PROFILE_SELECTION_LIMITS,
  normalizeSelectionList,
} from "../utils/profile-selection-limits.util";
import { FirebaseAdminService } from "../utils/firebase-admin.service";
import {
  normalizeSocialHandle,
  normalizeSocialMediaList,
  validateSocialHandle,
} from "../utils/social-handle.util";
import { consumeOtpVerificationToken } from "../otp/otp.controller";
import { CloudinaryService } from "../cloudinary.service";
import { CloudinaryFolders } from "../cloudinary-folders";

type AnyUserDoc = {
  email: string;
  name?: string;
  password?: string;
  isEmailVerified?: boolean;
  firebaseUid?: string | null;
  resetToken?: string;
  resetTokenExpires?: number;
  save: () => Promise<unknown>;
  [key: string]: unknown;
};

type FirebaseContactType = "email" | "phone";
type TrendstarzRole = "admin" | "influencer" | "brand" | "photographer";

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

  private async promoteLegacyEmailVerified(
    user: any,
    model: Model<any>,
  ): Promise<void> {
    if (!user || user.isEmailVerified === true || user.emailVerified !== true) {
      return;
    }
    const verifiedAt = user.emailVerifiedAt || new Date();
    user.isEmailVerified = true;
    user.emailVerifiedAt = verifiedAt;
    await model.updateOne(
      { _id: user._id },
      {
        $set: { isEmailVerified: true, emailVerifiedAt: verifiedAt },
      },
    );
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

  private async findAnyUserWithRole(
    email: string,
  ): Promise<{ user: any; role: TrendstarzRole } | null> {
    const [adminUser, influencer, brand, photographer] = await Promise.all([
      this.userModel.findOne({ email }),
      this.influencerModel.findOne({ email }),
      this.brandModel.findOne({ email }),
      this.photographerModel.findOne({ email }),
    ]);
    if (adminUser) {
      await this.promoteLegacyEmailVerified(adminUser, this.userModel);
      return { user: adminUser, role: "admin" };
    }
    if (influencer) {
      await this.promoteLegacyEmailVerified(influencer, this.influencerModel);
      return { user: influencer, role: "influencer" };
    }
    if (brand) {
      await this.promoteLegacyEmailVerified(brand, this.brandModel);
      return { user: brand, role: "brand" };
    }
    if (photographer) {
      await this.promoteLegacyEmailVerified(photographer, this.photographerModel);
      return { user: photographer, role: "photographer" };
    }
    return null;
  }

  private activateAfterEmailOwnership(
    user: any,
    role: TrendstarzRole | null,
    firebaseUid?: string,
  ): boolean {
    user.isEmailVerified = true;
    user.emailVerifiedAt = user.emailVerifiedAt || new Date();
    if (firebaseUid) user.firebaseUid = firebaseUid;
    if (role && role !== "admin" && user.status === "pending") {
      user.status = "accepted";
      return true;
    }
    return false;
  }

  private validateCreatorSocialMediaRates(socialMedia: any[]) {
    for (const sm of socialMedia || []) {
      if (!String(sm?.platform || "").trim()) {
        throw new BadRequestException("Platform is required.");
      }
      if (!String(sm?.handle || "").trim()) {
        throw new BadRequestException(
          "Username is required for every selected platform.",
        );
      }
      if (!String(sm?.tier || "").trim()) {
        throw new BadRequestException(
          "Tier is required for every selected platform.",
        );
      }
      if (!Array.isArray(sm?.contentTypes) || sm.contentTypes.length === 0) {
        throw new BadRequestException(
          "Please select at least one content type and enter a starting rate.",
        );
      }
    }
  }

  async sendEmailVerificationLink(email: string) {
    const normalizedEmail = (email || "").trim().toLowerCase();
    if (!normalizedEmail) {
      throw new BadRequestException("Email is required");
    }

    const match = await this.findAnyUserWithRole(normalizedEmail);
    if (!match) {
      // Avoid exposing user existence details.
      return {
        success: true,
        message: "If the email exists, a verification link has been sent.",
      };
    }
    const user = match.user;

    if (user.isEmailVerified) {
      return { success: true, message: "Email is already verified." };
    }

    let verifyUrl = "";
    if (this.firebaseAdminService.isConfigured()) {
      verifyUrl =
        await this.firebaseAdminService.generateEmailVerificationLink(
          normalizedEmail,
        );
      await this.firebaseAdminService.setUserRoleClaim(
        normalizedEmail,
        match.role,
      );
    } else {
      const token = jwt.sign(
        { email: normalizedEmail, purpose: "email_verification" },
        getJwtSecret(),
        { expiresIn: "1h" },
      );

      const backendUrl = (
        process.env.BACKEND_URL || "https://api.trendstarz.in"
      ).replace(/\/$/, "");
      verifyUrl = `${backendUrl}/api/auth/verify-email?token=${encodeURIComponent(token)}`;
    }
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
	    await this.promoteLegacyEmailVerified(
	      user,
	      adminUser
	        ? this.userModel
	        : influencer
	          ? this.influencerModel
	          : brand
	            ? this.brandModel
	            : this.photographerModel,
	    );

	    if (!user.isEmailVerified) {
      const role = adminUser
        ? "admin"
        : influencer
          ? "influencer"
          : brand
            ? "brand"
            : photographer
              ? "photographer"
              : null;
      const autoApproved = this.activateAfterEmailOwnership(user, role);

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

  async syncFirebaseEmailVerification(email: string) {
    const normalizedEmail = String(email || "")
      .trim()
      .toLowerCase();
    if (!normalizedEmail) {
      throw new BadRequestException("Email is required.");
    }
    if (!this.firebaseAdminService.isConfigured()) {
      throw new BadRequestException("Firebase Admin is not configured.");
    }
    let firebaseUser: any = null;
    try {
      firebaseUser =
        await this.firebaseAdminService.getUserByEmail(normalizedEmail);
    } catch {
      throw new BadRequestException("Firebase user not found.");
    }
    if (!firebaseUser?.emailVerified) {
      throw new BadRequestException("Firebase email is not verified yet.");
    }

    const [adminUser, influencer, brand, photographer] = await Promise.all([
      this.userModel.findOne({ email: normalizedEmail }),
      this.influencerModel.findOne({ email: normalizedEmail }),
      this.brandModel.findOne({ email: normalizedEmail }),
      this.photographerModel.findOne({ email: normalizedEmail }),
    ]);
	    const user = adminUser || influencer || brand || photographer;
	    const role = adminUser
	      ? "admin"
      : influencer
        ? "influencer"
        : brand
          ? "brand"
          : photographer
            ? "photographer"
            : null;
    if (!user) throw new BadRequestException("User not found.");

    const autoApproved = this.activateAfterEmailOwnership(
      user,
      role,
      firebaseUser?.uid,
    );
    await user.save();

    return {
      success: true,
      autoApproved,
      message: "Email verified successfully.",
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
    const frontendBase = (
      process.env.FRONTEND_URL || "https://www.trendstarz.in"
    ).replace(/\/$/, "");
    const resetUrl = `${frontendBase}/reset-password?token=${resetToken}`;
    const { subject, html, text } = resetPasswordTemplate(resetUrl);
    await sendAppEmail({ to: user.email, subject, html, text });
    user.resetToken = resetTokenHash;
    user.resetTokenExpires = Date.now() + 1000 * 60 * 60; // 1 hour expiry
    await user.save();
  }

  async validateResetToken(token: string): Promise<boolean> {
    if (!token) return false;
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const now = Date.now();
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
    return !!(adminUser || influencer || brand || photographer);
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
    const role = adminUser
      ? "admin"
      : influencer
        ? "influencer"
        : brand
          ? "brand"
          : photographer
            ? "photographer"
	            : null;

	    if (!user) {
	      throw new BadRequestException("Invalid or expired reset token");
	    }
	    await this.promoteLegacyEmailVerified(
	      user,
	      adminUser
	        ? this.userModel
	        : influencer
	          ? this.influencerModel
	          : brand
	            ? this.brandModel
	            : this.photographerModel,
	    );
	    if (this.firebaseAdminService.isConfigured()) {
      const firebaseUser = await this.firebaseAdminService.setEmailUserPassword(
        user.email,
        newPassword,
        true,
      );
      this.activateAfterEmailOwnership(user, role, firebaseUser.uid);
    } else {
      this.activateAfterEmailOwnership(user, role);
    }
    user.password = await bcrypt.hash(newPassword, 10);
    user.resetToken = null;
    user.resetTokenExpires = null;
    await user.save();
    return { success: true, message: "Password reset successfully." };
  }

  async ensureFirebasePasswordResetUser(email: string) {
    const normalizedEmail = String(email || "")
      .trim()
      .toLowerCase();
    if (!normalizedEmail) {
      throw new BadRequestException("Email is required.");
    }

    const match = await this.findAnyUserWithRole(normalizedEmail);
    if (!match) {
      return {
        success: true,
        canSendFirebaseReset: false,
        message: "If that email is registered, a reset link has been sent.",
      };
    }

    if (this.firebaseAdminService.isConfigured()) {
      await this.firebaseAdminService.ensureEmailUser(normalizedEmail);
    }

    return {
      success: true,
      canSendFirebaseReset: true,
      message: "If that email is registered, a reset link has been sent.",
    };
  }

  async completeFirebasePasswordReset(idToken: string, newPassword: string) {
    if (!idToken || !newPassword) {
      throw new BadRequestException(
        "Firebase token and new password are required.",
      );
    }
    this.validatePasswordStrength(newPassword);

    const decoded = await this.firebaseAdminService.verifyIdToken(idToken);
    const email = String(decoded.email || "")
      .trim()
      .toLowerCase();
    if (!email) {
      throw new BadRequestException(
        "Firebase token does not include an email.",
      );
    }

    const match = await this.findAnyUserWithRole(email);
    if (!match) {
      throw new BadRequestException("User not found.");
    }

    match.user.password = await bcrypt.hash(newPassword, 10);
    match.user.isEmailVerified = true;
    match.user.emailVerifiedAt = match.user.emailVerifiedAt || new Date();
    match.user.firebaseUid = decoded.uid;
    match.user.resetToken = null;
    match.user.resetTokenExpires = null;
    const autoApproved =
      match.role !== "admin"
        ? await this.maybeAutoApproveAfterContactVerification(
            match.user,
            match.role,
          )
        : false;
    await match.user.save();

    return {
      success: true,
      autoApproved,
      message: "Password reset successfully.",
    };
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

    if (this.firebaseAdminService.isConfigured()) {
      const firebaseUser = await this.firebaseAdminService.setEmailUserPassword(
        user.email,
        newPassword,
        !!user.isEmailVerified,
      );
      user.firebaseUid = firebaseUser.uid;
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
    @InjectModel("Counter") private readonly counterModel: Model<any>,
    @InjectModel("TrackingLink") private readonly trackingLinkModel: Model<any>,
    @InjectModel("LinkConversion") private readonly linkConversionModel: Model<any>,
    private readonly firebaseAdminService: FirebaseAdminService,
    private readonly cloudinaryService: CloudinaryService,
  ) {}

  // Generates the next sequential, role-prefixed human-readable ID (e.g.
  // "INF100057") using the shared `counters` collection (same mechanism as
  // Campaign.campaignNumber). Note: findOneAndUpdate+upsert does NOT apply
  // the schema's `default` on insert, so `seq` starts at 1 on first use —
  // the +100000 display offset is applied here rather than stored, keeping
  // this independent of that Mongoose quirk.
  private async nextPublicId(
    prefix: string,
    counterKey: string,
  ): Promise<string> {
    const doc = await this.counterModel.findOneAndUpdate(
      { _id: counterKey },
      { $inc: { seq: 1 } },
      { new: true, upsert: true },
    );
    return `${prefix}${100000 + doc.seq}`;
  }

  // Best-effort: if this signup came in through a referral tracking link (`?tlc=<code>`
  // captured by the registration form), record the conversion. Never blocks registration.
  private async recordSignupConversion(
    trackingLinkCode: unknown,
    userId: string,
    userType: "brand" | "influencer" | "photographer",
  ): Promise<void> {
    const code = String(trackingLinkCode || "").trim().toUpperCase();
    if (!code) return;
    try {
      const trackingLink = await this.trackingLinkModel.findOne({
        code,
        moduleType: "referral",
      });
      if (!trackingLink) return;
      await this.linkConversionModel.updateOne(
        { trackingLinkId: trackingLink._id, userId, conversionType: "signup" },
        { $setOnInsert: { trackingLinkId: trackingLink._id, userId, userType, conversionType: "signup", convertedAt: new Date() } },
        { upsert: true },
      );
    } catch (err) {
      console.error("Failed to record signup conversion:", err);
    }
  }

  // Moves images/docs uploaded to a `_pending` staging folder into their
  // final entity-scoped folder now that the document's _id is known. Called
  // after `new this.xModel(...)` (Mongoose assigns _id client-side) and
  // before `.save()`, so the doc is only written once.
  private async relocateAssets<T extends { url: string; public_id: string }>(
    assets: T[],
    folder: string,
  ): Promise<T[]> {
    if (!assets?.length) return assets;
    return Promise.all(
      assets.map(async (asset) => {
        const relocated = await this.cloudinaryService.relocateAsset(
          asset,
          folder,
        );
        return { ...asset, ...relocated };
      }),
    );
  }

  private modelForRole(role: string): Model<any> | null {
    const normalized = String(role || "").toLowerCase();
    if (normalized === "admin" || normalized === "subadmin" || normalized === "user") return this.userModel;
    if (normalized === "influencer") return this.influencerModel;
    if (normalized === "brand") return this.brandModel;
    if (normalized === "photographer") return this.photographerModel;
    return null;
  }

  // Fresh DB read — the JWT payload deliberately excludes isEmailVerified
  // (kept minimal at sign time), so this can't be trusted from req.user alone.
  async assertEmailVerified(userId: string, role: string): Promise<void> {
    const model = this.modelForRole(role);
    const doc = model
      ? await model.findById(userId).select("isEmailVerified").lean()
      : null;
    if (!doc || (doc as any).isEmailVerified !== true) {
      throw new ForbiddenException(
        "Verify your email before uploading files.",
      );
    }
  }

  /** Lightweight lookup so the live checkout page can show Founder Offer bonus eligibility without loading the full dashboard. */
  async getMyRegistration(userId: string, role: string) {
    const model = this.modelForRole(role);
    if (!model || !userId) {
      throw new BadRequestException("Invalid user session.");
    }
    const user = await model
      .findById(userId)
      .select("firstRegisteredAt createdAt")
      .lean();
    return {
      success: true,
      firstRegisteredAt:
        (user as any)?.firstRegisteredAt || (user as any)?.createdAt || null,
    };
  }

  async markSessionOpened(userId: string, role: string) {
    const model = this.modelForRole(role);
    if (!model || !userId) {
      throw new BadRequestException("Invalid user session.");
    }
    const lastOpenedAt = new Date();
    await model.updateOne({ _id: userId }, { $set: { lastOpenedAt } });
    return { success: true, lastOpenedAt };
  }

  /** Marks the first-login Founder Launch Offer modal as shown so it never re-shows full-screen for this user again. */
  async markFounderOfferSeen(userId: string, role: string) {
    const model = this.modelForRole(role);
    if (!model || !userId) {
      throw new BadRequestException("Invalid user session.");
    }
    const founderOfferSeenAt = new Date();
    await model.updateOne(
      { _id: userId, founderOfferSeenAt: null },
      { $set: { founderOfferSeenAt } },
    );
    return { success: true, founderOfferSeenAt };
  }

  async markCommunityJoined(
    userId: string,
    role: string,
    communityName: string,
    communityState = "",
  ) {
    const model = this.modelForRole(role);
    if (!model || !userId) {
      throw new BadRequestException("Invalid user session.");
    }
    const name = String(communityName || "").trim();
    const state = String(communityState || "").trim();
    if (!name) {
      throw new BadRequestException("Community name is required.");
    }
    const communityJoinedAt = new Date();
    await model.updateOne(
      { _id: userId },
      {
        $set: {
          communityJoined: true,
          communityState: state,
          communityName: name,
          communityJoinedAt,
          communityJoinedDate: communityJoinedAt,
        },
      },
    );
    return {
      success: true,
      communityJoined: true,
      communityState: state,
      communityName: name,
      communityJoinedAt,
      communityJoinedDate: communityJoinedAt,
    };
  }

  private normalizePhone(value: unknown): string {
    if (value === null || value === undefined) return "";
    if (typeof value !== "string" && typeof value !== "number") return "";
    return String(value).replace(/\D/g, "");
  }

  private phoneLookupValues(value: unknown): string[] {
    const digits = this.normalizePhone(value);
    if (!digits) return [];
    const values = new Set<string>([digits]);
    if (digits.length > 10) values.add(digits.slice(-10));
    if (digits.length === 10) {
      values.add(`91${digits}`);
      values.add(`+91${digits}`);
    }
    return Array.from(values);
  }

  private async maybeAutoApproveAfterContactVerification(
    user: any,
    role: "influencer" | "brand" | "photographer",
  ): Promise<boolean> {
    const settings = (await this.appSettingsModel.findOne({}).lean()) as any;
    if (!user?.isEmailVerified) return false;

    const mobileRequired =
      role === "influencer"
        ? !!settings?.influencerRequireMobileVerified
        : role === "brand"
          ? !!settings?.brandRequireMobileVerified
          : !!settings?.photographerRequireMobileVerified;

    if (mobileRequired && !user?.isMobileVerified) return false;

    const preApproveEnabled =
      role === "influencer"
        ? !!settings?.preApproveInfluencers
        : role === "brand"
          ? !!settings?.preApproveBrands
          : !!settings?.preApprovePhotographers;

    if (!preApproveEnabled || user.status !== "pending") return false;
    user.status = "accepted";
    return true;
  }

  private async bestEffortSyncFirebaseEmailVerified(
    email: string,
    isEmailVerified = true,
  ): Promise<void> {
    if (!this.firebaseAdminService.isConfigured()) return;
    try {
      await this.firebaseAdminService.setEmailVerified(email, isEmailVerified);
    } catch {
      // MongoDB remains the source of truth for admin/manual verification.
      // Firebase sync is best-effort so login is not blocked by provider drift.
    }
  }

  private async assertVerifiedFirebaseLogin(
    normalizedEmail: string,
    firebaseIdToken: string | undefined,
    user: any,
    role: "influencer" | "brand" | "photographer",
    options?: { localAuthBypass?: boolean },
  ): Promise<void> {
    if (options?.localAuthBypass) {
      user.isEmailVerified = true;
      user.emailVerifiedAt = user.emailVerifiedAt || new Date();
      if (!user.firebaseUid)
        user.firebaseUid = `local-dev:${role}:${normalizedEmail}`;
      await this.maybeAutoApproveAfterContactVerification(user, role);
      await user.save();
      return;
    }
    if (user?.isEmailVerified === true) {
      user.isEmailVerified = true;
      user.emailVerifiedAt = user.emailVerifiedAt || new Date();
      await this.maybeAutoApproveAfterContactVerification(user, role);
      await user.save();
      await this.bestEffortSyncFirebaseEmailVerified(normalizedEmail, true);
      return;
    }
    if (!this.firebaseAdminService.isConfigured()) {
      throw new UnauthorizedException(
        "Firebase verification is required before login.",
      );
    }
    if (!firebaseIdToken) {
      throw new UnauthorizedException(
        "Please verify your email before logging in.",
      );
    }

    const decoded =
      await this.firebaseAdminService.verifyIdToken(firebaseIdToken);
    const firebaseEmail = String(decoded.email || "")
      .trim()
      .toLowerCase();
    if (firebaseEmail !== normalizedEmail || !decoded.email_verified) {
      throw new UnauthorizedException(
        "Please verify your email before logging in.",
      );
    }

    user.isEmailVerified = true;
    user.emailVerifiedAt = user.emailVerifiedAt || new Date();
    user.firebaseUid = decoded.uid;
    await this.maybeAutoApproveAfterContactVerification(user, role);
    await user.save();
  }

  async verifyFirebaseContact(idToken: string, type: FirebaseContactType) {
    if (type !== "email" && type !== "phone") {
      throw new BadRequestException(
        "Verification type must be email or phone.",
      );
    }

    const decoded = await this.firebaseAdminService.verifyIdToken(idToken);
    let user: any = null;
    let role: "influencer" | "brand" | "photographer" | "admin" | null = null;

    if (type === "email") {
      const email = String(decoded.email || "")
        .trim()
        .toLowerCase();
      if (!email || !decoded.email_verified) {
        throw new BadRequestException("Firebase email is not verified.");
      }
      const [adminUser, influencer, brand, photographer] = await Promise.all([
        this.userModel.findOne({ email }),
        this.influencerModel.findOne({ email }),
        this.brandModel.findOne({ email }),
        this.photographerModel.findOne({ email }),
      ]);
      user = adminUser || influencer || brand || photographer;
      role = adminUser
        ? "admin"
        : influencer
          ? "influencer"
          : brand
            ? "brand"
            : photographer
              ? "photographer"
              : null;
      if (!user)
        throw new BadRequestException(
          "No TrendStarz user matches this Firebase email.",
        );
      this.activateAfterEmailOwnership(user, role, decoded.uid);
    } else {
      const phoneValues = this.phoneLookupValues(decoded.phone_number);
      if (!phoneValues.length) {
        throw new BadRequestException("Firebase phone number is not verified.");
      }
      const [influencer, brand, photographer] = await Promise.all([
        this.influencerModel.findOne({ phoneNumber: { $in: phoneValues } }),
        this.brandModel.findOne({ phoneNumber: { $in: phoneValues } }),
        this.photographerModel.findOne({ phoneNumber: { $in: phoneValues } }),
      ]);
      user = influencer || brand || photographer;
      role = influencer
        ? "influencer"
        : brand
          ? "brand"
          : photographer
            ? "photographer"
            : null;
	    if (!user)
	        throw new BadRequestException(
	          "No TrendStarz user matches this Firebase phone.",
	        );
      user.isMobileVerified = true;
      user.mobileVerified = true;
      user.mobileVerifiedAt = user.mobileVerifiedAt || new Date();
      user.mobileVerificationDate = user.mobileVerificationDate || new Date();
      user.mobileVerificationMethod = "OTP";
	    }

    const autoApproved =
      type === "email" && role !== "admin"
        ? user.status === "accepted"
        : role && role !== "admin"
          ? await this.maybeAutoApproveAfterContactVerification(user, role)
          : false;
    await user.save();

    return {
      success: true,
      autoApproved,
      message:
        type === "email"
          ? "Email verified successfully."
          : "Mobile verified successfully.",
    };
  }

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
      handle: normalizeSocialHandle(
        sm.handle,
        smMap.get(sm.platform) || sm.platform,
      ),
      contentTypes: Array.isArray(sm.contentTypes)
        ? sm.contentTypes
            .filter((ct: any) => {
              const price = Number(ct?.price);
              const selected = ct?.enabled === true || ct?.selected === true;
              return selected && Number.isFinite(price) && price > 0;
            })
            .map((ct: any) => ({
              name: String(ct?.name || ct?.label || "").trim(),
              enabled: true,
              price: Number(ct.price),
            }))
            .filter((ct: any) => !!ct.name)
        : [],
    }));
    for (const sm of socialMediaMapped) {
      const handleError = validateSocialHandle(sm.handle, sm.platform);
      if (handleError) throw new BadRequestException(handleError);
    }

    return {
      categoryNames,
      languageNames,
      stateName,
      districtName,
      socialMediaMapped,
    };
  }

  // Admin / influencer / brand login
  async login(
    email: string,
    password: string,
    firebaseIdToken?: string,
    options?: { localAuthBypass?: boolean },
  ) {
    const normalizedEmail = (email || "").trim().toLowerCase();

    // Fetch all collections in parallel to eliminate sequential DB round-trips
    // and prevent timing-based enumeration of which collection a user belongs to.
    const [adminUser, influencer, brand, photographer] = await Promise.all([
      this.userModel.findOne({ email: normalizedEmail, role: "admin" }),
      this.influencerModel.findOne({ email: normalizedEmail }),
      this.brandModel.findOne({ email: normalizedEmail }),
      this.photographerModel.findOne({ email: normalizedEmail }),
    ]);

    if (!adminUser && !influencer && !brand && !photographer) {
      throw new UnauthorizedException("Invalid credentials");
    }

    await Promise.all([
      this.promoteLegacyEmailVerified(adminUser, this.userModel),
      this.promoteLegacyEmailVerified(influencer, this.influencerModel),
      this.promoteLegacyEmailVerified(brand, this.brandModel),
      this.promoteLegacyEmailVerified(photographer, this.photographerModel),
    ]);

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
        { expiresIn: "90d" },
      );
      return {
        token,
        userType: adminUser.role,
        user: {
          id: adminUser._id,
          name: adminUser.name,
          email: adminUser.email,
          role: adminUser.role,
          lastLoginAt: now,
          lastOpenedAt: adminUser.lastOpenedAt || null,
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
      await this.assertVerifiedFirebaseLogin(
        normalizedEmail,
        firebaseIdToken,
        influencer,
        "influencer",
        options,
      );
      if (influencer.status === "pending" && !options?.localAuthBypass) {
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
        { expiresIn: "90d" },
      );
      return {
        token,
        userType: "influencer",
        user: {
          id: influencer._id,
          name: displayName,
          email: influencer.email,
          role: "influencer",
          lastLoginAt: now,
          lastOpenedAt: influencer.lastOpenedAt || null,
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
      await this.assertVerifiedFirebaseLogin(
        normalizedEmail,
        firebaseIdToken,
        brand,
        "brand",
        options,
      );
      if (brand.status === "pending" && !options?.localAuthBypass) {
        throw new UnauthorizedException(
          "Your account is pending approval. Please wait for admin to activate your account.",
        );
      }
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
        { expiresIn: "90d" },
      );
      return {
        token,
        userType: "brand",
        user: {
          id: brand._id,
          name: displayName,
          email: brand.email,
          role: "brand",
          lastLoginAt: now,
          lastOpenedAt: brand.lastOpenedAt || null,
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
      await this.assertVerifiedFirebaseLogin(
        normalizedEmail,
        firebaseIdToken,
        photographer,
        "photographer",
        options,
      );
      if (photographer.status === "pending" && !options?.localAuthBypass) {
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
        { expiresIn: "90d" },
      );
      return {
        token,
        userType: "photographer",
        user: {
          id: photographer._id,
          name: photographer.name || "",
          email: photographer.email,
          role: "photographer",
          lastLoginAt: now,
          lastOpenedAt: photographer.lastOpenedAt || null,
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
    const normalizedCategoryNames = normalizeSelectionList(
      categoryNames,
      PROFILE_SELECTION_LIMITS.influencer.categories,
    );
    this.validateCreatorSocialMediaRates(socialMediaMapped);
    const normalizedCreatorTypes = normalizeSelectionList(
      data?.creatorTypes,
      PROFILE_SELECTION_LIMITS.influencer.creatorTypes,
    );
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
      campaign:
        data?.signupAttribution?.campaign ||
        data?.campaign ||
        data?.utm_campaign ||
        null,
      content:
        data?.signupAttribution?.content ||
        data?.content ||
        data?.utm_content ||
        null,
      referrerPath:
        data?.signupAttribution?.referrerPath || data?.referrerPath || null,
      referrerUrl:
        data?.signupAttribution?.referrerUrl || data?.referrerUrl || null,
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
      categories: normalizedCategoryNames,
      creatorTypes: normalizedCreatorTypes,
      location: { state: stateName, district: districtName },
      languages: languageNames,
      socialMedia: socialMediaMapped,
      collaborationAvailability: normalizeCollaborationAvailability(
        data?.collaborationAvailability,
        "influencer",
      ),
      profileImages: normalizedProfileImages,
      signupAttribution,
      verificationDocuments: verificationDocs,
      verificationDisclaimerAccepted,
      verificationStatus,
      verifiedByTrendStarz: false,
      verificationAdminNotes: "",
      verificationAuditLog,
    });
    influencer.publicId = await this.nextPublicId(
      "INF",
      "influencer_public_id",
    );

    // Save first while assets still reference their `_pending/...` staging
    // path. Relocating before the doc exists would leave images permanently
    // moved into an `influencers/{id}/...` folder with no owning record if
    // `.save()` then failed — an orphan the `_pending` cleanup job can't see
    // because it isn't in `_pending` anymore. Only relocate once we know the
    // registration actually succeeded.
    try {
      await influencer.save();
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

    await this.recordSignupConversion(
      data?.trackingLinkCode,
      String(influencer._id),
      "influencer",
    );

    // Relocate staged uploads into their final influencers/{_id}/... folder
    // now that the document is confirmed saved.
    const influencerId = String(influencer._id);
    let relocationChanged = false;
    if (influencer.profileImages?.length) {
      const [profilePhoto, ...gallery] = influencer.profileImages;
      const [relocatedProfile] = await this.relocateAssets(
        [profilePhoto],
        CloudinaryFolders.influencer.profile(influencerId),
      );
      const relocatedGallery = await this.relocateAssets(
        gallery,
        CloudinaryFolders.influencer.gallery(influencerId),
      );
      influencer.profileImages = [relocatedProfile, ...relocatedGallery];
      relocationChanged = true;
    }
    if (influencer.verificationDocuments?.length) {
      influencer.verificationDocuments = await this.relocateAssets(
        influencer.verificationDocuments,
        CloudinaryFolders.influencer.verification(influencerId),
      );
      relocationChanged = true;
    }
    // Status stays "pending" until email is verified — auto-approve (if enabled) is applied in verifyEmailByToken.
    if (relocationChanged) {
      await influencer.save();
    }

    return {
      success: true,
      message: "Influencer registered",
      influencer,
    };
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
      campaign:
        data?.signupAttribution?.campaign ||
        data?.campaign ||
        data?.utm_campaign ||
        null,
      content:
        data?.signupAttribution?.content ||
        data?.content ||
        data?.utm_content ||
        null,
      referrerPath:
        data?.signupAttribution?.referrerPath || data?.referrerPath || null,
      referrerUrl:
        data?.signupAttribution?.referrerUrl || data?.referrerUrl || null,
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
    brand.publicId = await this.nextPublicId("BRD", "brand_public_id");

    // Save first while assets still reference their `_pending/...` staging
    // path — see the matching comment in registerInfluencer for why relocate
    // must not run before the document is confirmed saved.
    let savedBrand = await brand.save();

    await this.recordSignupConversion(
      data?.trackingLinkCode,
      String(savedBrand._id),
      "brand",
    );

    // Relocate staged uploads into their final brands/{_id}/... folder now
    // that the document is confirmed saved.
    const brandId = String(brand._id);
    let relocationChanged = false;
    if (brand.brandLogo?.length) {
      brand.brandLogo = await this.relocateAssets(
        brand.brandLogo,
        CloudinaryFolders.brand.logo(brandId),
      );
      relocationChanged = true;
    }
    if (brand.products?.length) {
      brand.products = await this.relocateAssets(
        brand.products,
        CloudinaryFolders.brand.products(brandId),
      );
      relocationChanged = true;
    }
    // Status stays "pending" until email is verified — auto-approve (if enabled) is applied in verifyEmailByToken.
    if (relocationChanged) {
      savedBrand = await brand.save();
    }

    return {
      success: true,
      message: "Brand registered",
      brand: savedBrand,
    };
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
    const normalizedSocialMedia = normalizeSocialMediaList(data?.socialMedia);
    this.validateCreatorSocialMediaRates(normalizedSocialMedia);
    const mobileOtpVerified = consumeOtpVerificationToken(
      "phone",
      normalizedPhone || data.phoneNumber,
      data?.mobileOtpVerificationToken,
    );

    const signupAttribution = {
      source:
        data?.signupAttribution?.source ||
        data?.source ||
        data?.utm_source ||
        null,
      audience: data?.signupAttribution?.audience || data?.audience || null,
      campaign:
        data?.signupAttribution?.campaign ||
        data?.campaign ||
        data?.utm_campaign ||
        null,
      content:
        data?.signupAttribution?.content ||
        data?.content ||
        data?.utm_content ||
        null,
      referrerPath:
        data?.signupAttribution?.referrerPath || data?.referrerPath || null,
      referrerUrl:
        data?.signupAttribution?.referrerUrl || data?.referrerUrl || null,
      capturedAt: new Date(),
    };

    const photographer = new this.photographerModel({
      ...data,
      username: normalizedUsername,
      email: normalizedEmail || data.email,
      phoneNumber: normalizedPhone || data.phoneNumber,
      isMobileVerified: mobileOtpVerified,
      mobileVerified: mobileOtpVerified,
      mobileVerifiedAt: mobileOtpVerified ? new Date() : null,
      mobileVerificationMethod: mobileOtpVerified ? "OTP" : "",
      password: hashedPassword,
      firstRegisteredAt: new Date(),
      location: { state: stateName, district: districtName },
      skills: normalizeSelectionList(
        data?.skills,
        PROFILE_SELECTION_LIMITS.photographer.skills,
      ),
      collaborationAvailability: normalizeCollaborationAvailability(
        data?.collaborationAvailability,
        "photographer",
      ),
      socialMedia: normalizedSocialMedia,
      profileImages: normalizedProfileImages,
      signupAttribution,
    });

    photographer.publicId = await this.nextPublicId(
      "PHO",
      "photographer_public_id",
    );

    // Save first while assets still reference their `_pending/...` staging
    // path — see the matching comment in registerInfluencer for why relocate
    // must not run before the document is confirmed saved.
    try {
      let saved = await photographer.save();

      await this.recordSignupConversion(
        data?.trackingLinkCode,
        String(saved._id),
        "photographer",
      );

      // Relocate staged uploads into their final photographers/{_id}/...
      // folder now that the document is confirmed saved.
      if (photographer.profileImages?.length) {
        const photographerId = String(photographer._id);
        const [profilePhoto, ...gallery] = photographer.profileImages;
        const [relocatedProfile] = await this.relocateAssets(
          [profilePhoto],
          CloudinaryFolders.photographer.profile(photographerId),
        );
        const relocatedGallery = await this.relocateAssets(
          gallery,
          CloudinaryFolders.photographer.gallery(photographerId),
        );
        photographer.profileImages = [relocatedProfile, ...relocatedGallery];
        saved = await photographer.save();
      }

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
      brandFeePercent: settings?.brandFeePercent ?? settings?.platformFeePercent ?? 10,
      influencerFeePercent: settings?.influencerFeePercent ?? 0,
      photographerFeePercent: settings?.photographerFeePercent ?? 0,
      influencerRecipientFeePercent: settings?.influencerRecipientFeePercent ?? 0,
      photographerRecipientFeePercent: settings?.photographerRecipientFeePercent ?? 0,
      brandRecipientFeePercent: settings?.brandRecipientFeePercent ?? 0,
      platformCommissionPercent: settings?.platformCommissionPercent ?? 12,
      inviteUnlockFee: settings?.inviteUnlockFee ?? 499,
      minimumCampaignFee: settings?.minimumCampaignFee ?? 1000,
      gstPercent: settings?.gstPercent ?? 18,
      submissionApprovalWaitHours: settings?.submissionApprovalWaitHours ?? 24,
      submissionAutoCompleteGraceHours:
        settings?.submissionAutoCompleteGraceHours ?? 48,
      payoutReleaseWaitHours: settings?.payoutReleaseWaitHours ?? 24,
      minCampaignStartDays: settings?.minCampaignStartDays ?? 3,
      maxCampaignDurationDays: settings?.maxCampaignDurationDays ?? 15,
      otpVerificationEnabled: !!settings?.otpVerificationEnabled,
      // Campaign payment UPI shown to brands on the payment screen
      paymentUpiId: settings?.paymentUpiId || "trendstarzin@kotak",
      // Premium upgrade payment method gating
      paymentGatewayMode: settings?.paymentGatewayMode || "razorpay_fallback",
      razorpayConfigured: !!(
        process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET
      ),
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
