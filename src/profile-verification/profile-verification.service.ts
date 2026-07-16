import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Types } from "mongoose";
import { WhatsAppService } from "../whatsapp/whatsapp.service";

type ProfileRole = "influencer" | "brand" | "photographer" | "admin";
export type ProfileUserType = "Influencer" | "Brand" | "Photographer" | "User";

const TIER_RANGES: Record<string, [number, number]> = {
  Starter: [0, 100],
  Nano: [101, 1000],
  Micro: [1001, 10000],
  "Mid-Tier": [10001, 100000],
  Macro: [100001, Number.MAX_SAFE_INTEGER],
  "Mega / Celebrity": [100001, Number.MAX_SAFE_INTEGER],
};

const FLAG_META: Record<
  string,
  { category: string; severity: string; message: string }
> = {
  PROFILE_PHOTO_PENDING_REVIEW: {
    category: "Identity",
    severity: "Medium",
    message: "Profile photo is pending admin review. Please allow 24-48 hours.",
  },
  PROFILE_PHOTO_MISSING: {
    category: "Identity",
    severity: "Medium",
    message: "Profile photo is missing.",
  },
  PROFILE_PHOTO_SCREENSHOT: {
    category: "Identity",
    severity: "High",
    message: "Profile image appears to be a screenshot or social media UI.",
  },
  PROFILE_PHOTO_LOW_QUALITY: {
    category: "Identity",
    severity: "Medium",
    message:
      "Profile photo appears to be low quality or below the recommended size.",
  },
  LOCATION_MISSING: {
    category: "Location",
    severity: "Low",
    message: "Location is missing.",
  },
  SOCIAL_LINK_MISSING: {
    category: "Social Media",
    severity: "Medium",
    message: "Social profile details are missing.",
  },
  SOCIAL_LINK_BROKEN: {
    category: "Social Media",
    severity: "High",
    message: "Social profile link or handle looks invalid.",
  },
  SOCIAL_LINK_DUPLICATE: {
    category: "Social Media",
    severity: "Medium",
    message: "Duplicate social platform entries were found.",
  },
  FOLLOWER_COUNT_MISMATCH: {
    category: "Social Media",
    severity: "Medium",
    message: "Follower count is missing or inconsistent.",
  },
  TIER_MISMATCH: {
    category: "Social Media",
    severity: "Medium",
    message: "Follower count does not match the selected tier.",
  },
  NICHE_MISSING: {
    category: "Content",
    severity: "Low",
    message: "Category, niche, or creator type is missing.",
  },
  PORTFOLIO_MISSING: {
    category: "Portfolio",
    severity: "Low",
    message: "Portfolio or gallery is missing.",
  },
  PORTFOLIO_SCREENSHOT: {
    category: "Portfolio",
    severity: "Medium",
    message: "Portfolio image appears to be a screenshot.",
  },
  PORTFOLIO_LOW_QUALITY: {
    category: "Portfolio",
    severity: "Low",
    message: "Portfolio image appears to be low quality.",
  },
  PORTFOLIO_DUPLICATE: {
    category: "Portfolio",
    severity: "Low",
    message: "Duplicate portfolio uploads were found.",
  },
  PORTFOLIO_WATERMARK: {
    category: "Portfolio",
    severity: "Medium",
    message: "Portfolio image appears to contain a watermark.",
  },
  EMAIL_NOT_VERIFIED: {
    category: "Verification",
    severity: "High",
    message: "Email is not verified.",
  },
  MOBILE_NOT_VERIFIED: {
    category: "Verification",
    severity: "High",
    message: "Mobile number is not verified.",
  },
  ID_PENDING: {
    category: "Verification",
    severity: "Low",
    message: "Admin verification review is pending.",
  },
  PAYMENT_MISSING: {
    category: "Payment",
    severity: "High",
    message: "Payment or payout details are missing.",
  },
};

const SCORE_ONLY_FLAG_CODES = new Set<string>([
  "FOLLOWER_COUNT_MISMATCH",
  "PORTFOLIO_MISSING",
]);

const ADMIN_ONLY_FLAG_CODES = new Set<string>(["ID_PENDING"]);

const HIDDEN_ACTION_FLAG_CODES = new Set<string>([
  ...SCORE_ONLY_FLAG_CODES,
  ...ADMIN_ONLY_FLAG_CODES,
]);

const SOCIAL_ACTION_FLAG_CODES = new Set<string>([
  "SOCIAL_LINK_MISSING",
  "SOCIAL_LINK_BROKEN",
  "SOCIAL_LINK_DUPLICATE",
  "TIER_MISMATCH",
]);

const PERSISTENT_REVIEW_FLAG_CODES = new Set<string>([
  "PROFILE_PHOTO_PENDING_REVIEW",
]);

const AUTO_FLAG_CODES = new Set(
  Object.keys(FLAG_META).filter(
    (code) => !PERSISTENT_REVIEW_FLAG_CODES.has(code),
  ),
);

// Quality/aesthetic issues — hide from public search/discovery, campaigns unaffected
const PROFILE_PHOTO_QUALITY_FLAG_CODES = new Set<string>([
  "PROFILE_PHOTO_QUALITY",
  "PROFILE_PHOTO_PENDING_REVIEW",
  "PROFILE_PHOTO_MISSING",
  "PROFILE_PHOTO_GROUP",
  "PROFILE_PHOTO_BLURRY",
  "PROFILE_PHOTO_LOGO",
  "PROFILE_PHOTO_LOW_QUALITY",
  "FACE_NOT_VISIBLE",
  "PROFILE_PHOTO_SCREENSHOT",
]);

// Identity/trust safety violations — hide from search AND block campaign invites
export const PROFILE_PHOTO_SAFETY_FLAG_CODES = new Set<string>([
  "PROFILE_PHOTO_POLICY",
  "PROFILE_PHOTO_CELEBRITY",
  "PROFILE_PHOTO_CONTACT_INFO",
  "PROFILE_PHOTO_QR_CODE",
]);

// Legacy alias
const PROFILE_PHOTO_POLICY_FLAG_CODES = PROFILE_PHOTO_SAFETY_FLAG_CODES;

// All photo flags block from search (quality + safety)
const PROFILE_PHOTO_VISIBILITY_BLOCK_FLAG_CODES = new Set<string>([
  ...PROFILE_PHOTO_QUALITY_FLAG_CODES,
  ...PROFILE_PHOTO_SAFETY_FLAG_CODES,
]);

const PROFILE_PHOTO_ADMIN_REVIEW_FLAG_CODES = new Set<string>([
  ...PROFILE_PHOTO_VISIBILITY_BLOCK_FLAG_CODES,
]);

// Category-level user messages — one per taxonomy category
const PROFILE_PHOTO_QUALITY_MESSAGE =
  "Profile photo quality needs improvement. Please upload a clear, high-quality photo.";

const PROFILE_PHOTO_FACE_MESSAGE =
  "Your profile photo must clearly show your face and contain only one person.";

const PROFILE_PHOTO_SCREENSHOT_MESSAGE =
  "Screenshots are not allowed. Please upload an original photo.";

const PROFILE_PHOTO_IDENTITY_MESSAGE =
  "Please upload your own photo. Celebrity photos, logos, and third-party images are not allowed.";

const PROFILE_PHOTO_SAFETY_MESSAGE =
  "Your photo contains content that violates platform guidelines.";

// All quality codes (hide from search; campaigns unaffected)
const PHOTO_QUALITY_CODES = new Set([
  "PROFILE_PHOTO_QUALITY", "PROFILE_PHOTO_BLURRY", "PROFILE_PHOTO_GROUP",
  "PROFILE_PHOTO_LOGO", "PROFILE_PHOTO_LOW_QUALITY", "FACE_NOT_VISIBLE",
  "PROFILE_PHOTO_SCREENSHOT",
]);
// Safety codes (hide from search AND block campaigns)
const PHOTO_POLICY_CODES_SET = PROFILE_PHOTO_SAFETY_FLAG_CODES;

// Map each flag code to its category-level user message
const PHOTO_FLAG_MESSAGES: Record<string, string> = {
  "PROFILE_PHOTO_QUALITY":      PROFILE_PHOTO_QUALITY_MESSAGE,
  "PROFILE_PHOTO_BLURRY":       PROFILE_PHOTO_QUALITY_MESSAGE,
  "PROFILE_PHOTO_LOW_QUALITY":  PROFILE_PHOTO_QUALITY_MESSAGE,
  "FACE_NOT_VISIBLE":           PROFILE_PHOTO_FACE_MESSAGE,
  "PROFILE_PHOTO_GROUP":        PROFILE_PHOTO_FACE_MESSAGE,
  "PROFILE_PHOTO_SCREENSHOT":   PROFILE_PHOTO_SCREENSHOT_MESSAGE,
  "PROFILE_PHOTO_CELEBRITY":    PROFILE_PHOTO_IDENTITY_MESSAGE,
  "PROFILE_PHOTO_LOGO":         PROFILE_PHOTO_IDENTITY_MESSAGE,
  "PROFILE_PHOTO_POLICY":       PROFILE_PHOTO_SAFETY_MESSAGE,
  "PROFILE_PHOTO_CONTACT_INFO": PROFILE_PHOTO_SAFETY_MESSAGE,
  "PROFILE_PHOTO_QR_CODE":      PROFILE_PHOTO_SAFETY_MESSAGE,
};

const GALLERY_FLAG_CODES_SET = new Set([
  "PORTFOLIO_MISSING", "PORTFOLIO_SCREENSHOT", "PORTFOLIO_LOW_QUALITY",
  "PORTFOLIO_DUPLICATE", "PORTFOLIO_WATERMARK",
]);
const GALLERY_FLAG_MESSAGES: Record<string, string> = {
  "PORTFOLIO_MISSING":     "Some gallery images are missing. Please add at least 3 portfolio images.",
  "PORTFOLIO_SCREENSHOT":  "Some gallery images are screenshots. Please upload original photos.",
  "PORTFOLIO_LOW_QUALITY": "Some gallery images are low quality or contain watermarks. Please upload higher quality images.",
  "PORTFOLIO_DUPLICATE":   "Your gallery contains duplicate images. Please upload varied original content.",
  "PORTFOLIO_WATERMARK":   "Some gallery images contain watermarks. Please upload clean, unbranded images.",
};

@Injectable()
export class ProfileVerificationService {
  constructor(
    @InjectModel("ProfileFlag") private readonly flagModel: Model<any>,
    @InjectModel("Influencer") private readonly influencerModel: Model<any>,
    @InjectModel("Brand") private readonly brandModel: Model<any>,
    @InjectModel("Photographer") private readonly photographerModel: Model<any>,
    @InjectModel("User") private readonly userModel: Model<any>,
    private readonly whatsAppService: WhatsAppService,
  ) {}

  private normalizeRole(role: any): ProfileRole {
    const normalized = String(role || "").toLowerCase();
    if (normalized === "brand") return "brand";
    if (normalized === "photographer") return "photographer";
    if (normalized === "admin") return "admin";
    return "influencer";
  }

  private toUserType(role: any): ProfileUserType {
    const normalized = this.normalizeRole(role);
    if (normalized === "brand") return "Brand";
    if (normalized === "photographer") return "Photographer";
    if (normalized === "admin") return "User";
    return "Influencer";
  }

  private modelForUserType(userType: ProfileUserType): Model<any> {
    if (userType === "Brand") return this.brandModel;
    if (userType === "Photographer") return this.photographerModel;
    if (userType === "User") return this.userModel;
    return this.influencerModel;
  }

  private objectIdOrString(id: string): any {
    return Types.ObjectId.isValid(id) ? new Types.ObjectId(id) : id;
  }

  private async loadProfile(userId: string, role: any) {
    const userType = this.toUserType(role);
    const profile = (await this.modelForUserType(userType)
      .findById(this.objectIdOrString(userId))
      .lean()) as any;
    if (!profile) throw new NotFoundException("Profile not found");
    return { userType, profile };
  }

  private isEmailVerified(profile: any): boolean {
    return profile?.isEmailVerified === true;
  }

  private isMobileVerified(profile: any): boolean {
    return (
      profile?.mobileVerified === true || profile?.isMobileVerified === true
    );
  }

  private hasText(value: any): boolean {
    return String(value || "").trim().length > 0;
  }

  private hasLocation(profile: any): boolean {
    return (
      this.hasText(profile?.location?.state) ||
      this.hasText(profile?.location?.district)
    );
  }

  private profileImageUrls(profile: any): string[] {
    const urls: string[] = [];
    for (const img of this.profileImageItems(profile)) {
      if (this.hasText(img?.url)) urls.push(String(img.url));
      else if (this.hasText(img)) urls.push(String(img));
    }
    return urls;
  }

  private profileImageItems(profile: any): any[] {
    const items: any[] = [];
    // profileImages[0]/brandLogo[0] is the live source of truth; profileImage is
    // a legacy field that can go stale after a re-upload/recrop, so it only
    // contributes as a fallback when the live array is empty.
    for (const img of profile?.profileImages || profile?.brandLogo || []) {
      items.push(img);
    }
    if (!items.length && this.hasText(profile?.profileImage)) {
      items.push({
        url: String(profile.profileImage),
        public_id: profile?.profileImagePublicId,
      });
    }
    return items;
  }

  private galleryImageItems(profile: any): any[] {
    // profileImages[1:]/products is the live gallery the user actually manages
    // from their edit screen. The legacy `galleryImages` field is no longer
    // written by any current flow (only cleared on plan downgrade), so stale
    // leftover entries in it must not be treated as the user's gallery —
    // otherwise users see flags for "screenshots" they can't see or remove.
    const profileImages = Array.isArray(profile?.profileImages)
      ? profile.profileImages
      : [];
    if (profileImages.length > 1) return profileImages.slice(1);
    if (Array.isArray(profile?.products) && profile.products.length) {
      return [...profile.products];
    }
    return [];
  }

  private galleryImageUrls(profile: any): string[] {
    const urls: string[] = [];
    for (const img of this.galleryImageItems(profile)) {
      if (this.hasText(img?.url)) urls.push(String(img.url));
      else if (this.hasText(img)) urls.push(String(img));
    }
    return urls;
  }

  private portfolioUrls(profile: any): string[] {
    const urls: string[] = this.galleryImageUrls(profile);
    if (this.hasText(profile?.portfolio)) urls.push(String(profile.portfolio));
    return urls;
  }

  /** Mirrors the Search/Welcome eligibility socialMedia $elemMatch (handle + tier-or-followers). */
  private hasSocialTier(profile: any): boolean {
    const list = Array.isArray(profile?.socialMedia) ? profile.socialMedia : [];
    return list.some(
      (sm: any) =>
        this.hasText(sm?.handle) &&
        (this.hasText(sm?.tier) || Number(sm?.followersCount || 0) > 0),
    );
  }

  /** Public — also used by CampaignsService to gate a Brand/Photographer posting a campaign. */
  isAdminApproved(profile: any): boolean {
    return (
      profile?.verifiedByTrendStarz === true ||
      String(profile?.verificationStatus || "").toLowerCase() === "approved"
    );
  }

  /** Display label for the real admin-approval state (verificationStatus), distinct from the profileTier quality label. */
  private verificationStatusLabel(profile: any): string {
    if (this.isAdminApproved(profile)) return "Approved";
    const raw = String(profile?.verificationStatus || "not_submitted").toLowerCase();
    switch (raw) {
      case "pending":
        return "Under Review";
      case "rejected":
        return "Rejected";
      case "removed":
        return "Removed";
      default:
        return "Pending";
    }
  }

  /**
   * "Profile Complete" / "Company Profile Complete" / "Portfolio Uploaded" —
   * the role-specific completeness bar for Campaign eligibility. Deliberately
   * mirrors Search/Welcome eligibility's photo+location(+social-tier) bar
   * (see applySearchEligibilityFilter in profile-eligibility.util.ts) so the
   * three eligibility tiers stay easy to reason about: Search = this bar;
   * Welcome/Campaign = this bar + admin approval.
   *
   * Public — also used by CampaignsService to gate a Brand/Photographer
   * posting a campaign, so "can this owner post" and "can this profile be
   * invited/accept" share one definition of "complete" per role.
   */
  isProfileComplete(profile: any, userType: ProfileUserType): boolean {
    const hasPhoto = this.profileImageUrls(profile).length > 0;
    const hasLoc = this.hasLocation(profile);
    if (userType === "Brand") {
      return hasPhoto && hasLoc;
    }
    if (userType === "Photographer") {
      return (
        hasPhoto &&
        hasLoc &&
        this.hasSocialTier(profile) &&
        this.portfolioUrls(profile).length > 0
      );
    }
    return hasPhoto && hasLoc && this.hasSocialTier(profile);
  }

  private looksLikeScreenshot(url: string): boolean {
    return /(screenshot|screen-shot|instagram|youtube|facebook|whatsapp|statusbar|status-bar|story|reel-ui|mobile-ui)/i.test(
      url || "",
    );
  }

  private looksLowQuality(item: any): boolean {
    const width = Number(item?.width || item?.metadata?.width || 0);
    const height = Number(item?.height || item?.metadata?.height || 0);
    return !!width && !!height && (width < 500 || height < 500);
  }

  private looksWatermarked(url: string): boolean {
    return /(watermark|wm_|sample|preview|shutterstock|getty|stock)/i.test(
      url || "",
    );
  }

  private hasPayout(profile: any): boolean {
    const payout = profile?.payout || {};
    return (
      this.hasText(payout.upiId) ||
      (this.hasText(payout.mobile) && this.hasText(payout.accountHolderName))
    );
  }

  private expectedTier(followers: number): string {
    for (const [tier, [min, max]] of Object.entries(TIER_RANGES)) {
      if (followers >= min && followers <= max) return tier;
    }
    return "";
  }

  private computeCompletion(
    profile: any,
    userType: ProfileUserType,
    flags: any[] = [],
  ): number {
    let score = 0;
    const hasOpenFlag = (code: string) =>
      flags.some((flag) => flag?.status === "Open" && flag?.flagCode === code);
    const hasOpenProfilePhotoIssue = flags.some((flag) => {
      const code = String(flag?.flagCode || "");
      return (
        flag?.status === "Open" &&
        PROFILE_PHOTO_VISIBILITY_BLOCK_FLAG_CODES.has(code)
      );
    });
    const hasOpenLocationIssue = ["LOCATION_MISSING", "LOCATION_MISMATCH", "INTERNATIONAL_LOCATION"].some((code) =>
      hasOpenFlag(code),
    );
    const hasOpenSocialIssue = [
      "SOCIAL_LINK_MISSING",
      "SOCIAL_LINK_BROKEN",
      "SOCIAL_LINK_PRIVATE",
      "SOCIAL_LINK_MISMATCH",
      "SOCIAL_LINK_DUPLICATE",
      "FOLLOWER_COUNT_MISMATCH",
      "TIER_MISMATCH",
    ].some((code) => hasOpenFlag(code));
    const hasOpenPortfolioIssue = [
      "PORTFOLIO_MISSING",
      "PORTFOLIO_SCREENSHOT",
      "PORTFOLIO_LOW_QUALITY",
      "PORTFOLIO_DUPLICATE",
      "PORTFOLIO_WATERMARK",
    ].some((code) => hasOpenFlag(code));
    const hasOpenPaymentIssue = [
      "PAYMENT_MISSING",
      "PAYMENT_PENDING",
      "PAYMENT_FAILED",
      "PAN_MISSING",
    ].some((code) => hasOpenFlag(code));
    const name = profile?.name || profile?.brandName;
    const basic =
      this.hasText(name) &&
      this.hasText(profile?.email) &&
      (this.hasText(profile?.phoneNumber) || this.hasText(profile?.phone));
    if (basic) score += 25;

    const social = Array.isArray(profile?.socialMedia)
      ? profile.socialMedia.some(
          (sm: any) => this.hasText(sm?.platform) && this.hasText(sm?.handle),
        )
      : false;
    const audience = Array.isArray(profile?.socialMedia)
      ? profile.socialMedia.some(
          (sm: any) =>
            Number(sm?.followersCount || 0) > 0 || this.hasText(sm?.tier),
        )
      : false;
    if ((social || audience) && !hasOpenSocialIssue) score += 15;

    const portfolio =
      this.portfolioUrls(profile).length > 0 ||
      this.profileImageUrls(profile).length > 1;
    if (portfolio && !hasOpenPortfolioIssue) score += 5;

    if (this.isEmailVerified(profile)) score += 10;
    if (this.isMobileVerified(profile)) score += 10;
    if (this.profileImageUrls(profile).length > 0 && !hasOpenProfilePhotoIssue)
      score += 15;
    if (this.hasLocation(profile) && !hasOpenLocationIssue)
      score += 10;
    if (this.hasPayout(profile) && !hasOpenPaymentIssue) score += 10;
    return Math.max(0, Math.min(100, score));
  }

  private qualityFromFlags(flags: any[], baseScore = 0): {
    score: number;
    label: string;
    status: string;
  } {
    const penalty = (flags || []).reduce((sum, flag) => {
      if (flag.severity === "High") return sum + 15;
      if (flag.severity === "Medium") return sum + 10;
      return sum + 5;
    }, 0);
    const score = Math.max(0, Math.min(100, Number(baseScore || 0) - penalty));
    // These tiers describe profile data quality only — never admin approval.
    // See isAdminApproved() / isTrendstarzVerified for the actual approval gate.
    const label =
      score <= 40
        ? "Poor"
        : score <= 60
          ? "Needs Improvement"
          : score <= 80
            ? "Good"
            : score <= 95
              ? "Brand Ready"
              : "Outstanding Profile";
    const hasActionRequired = flags.some((flag) => {
      const code = String(flag?.flagCode || "");
      return (
        !HIDDEN_ACTION_FLAG_CODES.has(code) &&
        ["High", "Medium"].includes(String(flag?.severity || ""))
      );
    });
    const status =
      hasActionRequired || score <= 60
        ? "Needs Attention"
        : score <= 80
          ? "Good Profile"
          : score <= 95
            ? "Brand Ready"
            : "Outstanding Profile";
    return { score, label, status };
  }

  private checklist(profile: any, flags: any[], userType: ProfileUserType) {
    const hasOpenFlag = (code: string) =>
      flags.some((flag) => flag.flagCode === code && flag.status === "Open");
    const galleryCount = this.galleryImageUrls(profile).length;
    const items = [
      {
        label: "Email Verified",
        status: this.isEmailVerified(profile) ? "Verified" : "Action Required",
      },
      {
        label: "Mobile Verified",
        status: this.isMobileVerified(profile) ? "Verified" : "Action Required",
      },
      {
        label: "Profile Photo",
        status: hasOpenFlag("PROFILE_PHOTO_PENDING_REVIEW")
          ? "Pending"
          : [...PROFILE_PHOTO_VISIBILITY_BLOCK_FLAG_CODES].some((code) =>
                hasOpenFlag(code),
              )
            ? "Action Required"
            : "Verified",
      },
      {
        label: "Social Profile & Creator Tier",
        status:
          [
            "SOCIAL_LINK_MISSING",
            "SOCIAL_LINK_BROKEN",
            "SOCIAL_LINK_PRIVATE",
            "SOCIAL_LINK_MISMATCH",
            "SOCIAL_LINK_DUPLICATE",
            "FOLLOWER_COUNT_MISMATCH",
            "TIER_MISMATCH",
          ].some((code) => hasOpenFlag(code))
            ? "Action Required"
            : "Verified",
      },
      {
        label: "Location",
        status:
          hasOpenFlag("LOCATION_MISSING") ||
          hasOpenFlag("LOCATION_MISMATCH") ||
          hasOpenFlag("INTERNATIONAL_LOCATION")
            ? "Action Required"
            : "Verified",
      },
      {
        label: "Gallery Images Attached",
        status:
          hasOpenFlag("PORTFOLIO_MISSING") ||
          hasOpenFlag("PORTFOLIO_SCREENSHOT") ||
          hasOpenFlag("PORTFOLIO_LOW_QUALITY") ||
          hasOpenFlag("PORTFOLIO_DUPLICATE") ||
          hasOpenFlag("PORTFOLIO_WATERMARK")
            ? "Action Required"
            : galleryCount > 0 || userType === "Brand"
              ? "Verified"
              : "Action Required",
      },
      {
        label: "Payment Method Verified",
        status: hasOpenFlag("PAYMENT_MISSING") ||
          hasOpenFlag("PAYMENT_PENDING") ||
          hasOpenFlag("PAYMENT_FAILED") ||
          hasOpenFlag("PAN_MISSING")
            ? "Action Required"
            : this.hasPayout(profile)
              ? "Verified"
              : "Not Added",
      },
      {
        label: "Admin Review Pending",
        status: this.isAdminApproved(profile) ? "Verified" : "Pending",
      },
    ];
    return items;
  }

  private verificationChecks(profile: any) {
    return {
      emailVerified: this.isEmailVerified(profile),
      emailVerifiedAt: profile?.emailVerifiedAt || null,
      mobileVerified: this.isMobileVerified(profile),
      mobileVerifiedAt:
        profile?.mobileVerifiedAt || profile?.mobileVerificationDate || null,
      mobileVerificationMethod: profile?.mobileVerificationMethod || "",
      verificationCallCompleted: !!profile?.verificationCallCompleted,
      verificationCallCompletedAt: profile?.verificationCallCompletedAt || null,
      identityVerified: !!(
        profile?.identityVerified || profile?.identityConfirmed
      ),
      identityVerifiedAt: profile?.identityVerifiedAt || null,
      verifiedByAdmin: profile?.verifiedByAdmin || "",
      locationVerified: !!profile?.locationVerified,
      locationVerifiedAt: profile?.locationVerifiedAt || null,
      socialVerified: !!(
        profile?.socialVerified || profile?.socialProfilesReviewed
      ),
      socialVerifiedAt:
        profile?.socialVerifiedAt || profile?.socialProfilesReviewedAt || null,
      paymentVerified: this.hasPayout(profile) && profile?.paymentVerified !== false,
      paymentVerifiedAt: profile?.paymentVerifiedAt || null,
      panVerified: !!profile?.panVerified,
      panVerifiedAt: profile?.panVerifiedAt || null,
      lastReviewedAt: profile?.lastReviewedAt || null,
      reviewedBy: profile?.reviewedBy || "",
    };
  }

  private verificationBadges(profile: any) {
    const checks = this.verificationChecks(profile);
    return [
      { label: "Email Verified", verified: checks.emailVerified },
      { label: "Mobile Verified", verified: checks.mobileVerified },
      { label: "Identity Verified", verified: checks.identityVerified },
      { label: "Location Verified", verified: checks.locationVerified },
      { label: "Social Verified", verified: checks.socialVerified },
      { label: "Payment Verified", verified: checks.paymentVerified },
    ];
  }

  private async upsertAutoFlag(
    userId: string,
    userType: ProfileUserType,
    flagCode: string,
    override?: Partial<{ message: string; severity: string; category: string }>,
  ) {
    const meta = { ...(FLAG_META[flagCode] || {}), ...(override || {}) };
    await this.flagModel.updateOne(
      { userId: String(userId), userType, flagCode, status: "Open" },
      {
        $setOnInsert: {
          createdAt: new Date(),
          auditLog: [
            {
              action: "created",
              actorId: "AUTO",
              actorRole: "system",
              actedAt: new Date(),
            },
          ],
        },
        $set: {
          category: meta.category || "Identity",
          severity: meta.severity || "Low",
          message: meta.message || flagCode,
          createdBy: "AUTO",
        },
      },
      { upsert: true },
    );
  }

  private async refreshAutomaticFlags(
    userId: string,
    userType: ProfileUserType,
    profile: any,
  ) {
    const desired = new Set<string>();
    const add = async (code: string, override?: any) => {
      desired.add(code);
      await this.upsertAutoFlag(userId, userType, code, override);
    };

    const profileImages = this.profileImageUrls(profile);
    if (!profileImages.length) await add("PROFILE_PHOTO_MISSING");
    if (profileImages.some((url) => this.looksLikeScreenshot(url)))
      await add("PROFILE_PHOTO_SCREENSHOT");
    if (
      this.profileImageItems(profile).some((item: any) =>
        this.looksLowQuality(item),
      )
    ) {
      await add("PROFILE_PHOTO_LOW_QUALITY");
    }
    if (!this.hasLocation(profile)) await add("LOCATION_MISSING");

    // Social media is optional for Brands — never auto-flag missing/broken social links.
    // Admin can still manually add a social flag on a Brand profile for informational
    // purposes, but it will NOT block the brand from search or campaign creation.
    if (userType !== "Brand") {
      const socials = Array.isArray(profile?.socialMedia)
        ? profile.socialMedia
        : [];
      if (!socials.length) {
        await add("SOCIAL_LINK_MISSING");
      } else {
        const platforms = new Set<string>();
        for (const sm of socials) {
          const platform = String(sm?.platform || "")
            .trim()
            .toLowerCase();
          const handle = String(sm?.handle || "").trim();
          if (platform && platforms.has(platform))
            await add("SOCIAL_LINK_DUPLICATE");
          if (platform) platforms.add(platform);
          if (!platform || !handle) await add("SOCIAL_LINK_BROKEN");
          const followers = Number(sm?.followersCount || 0);
          const expected = followers > 0 ? this.expectedTier(followers) : "";
          if (
            expected &&
            this.hasText(sm?.tier) &&
            expected !== String(sm.tier).trim()
          ) {
            await add("TIER_MISMATCH", {
              message: `${sm.platform || "Social profile"} has ${followers} followers, expected ${expected} tier.`,
            });
          }
        }
      }
    }

    const hasNiche =
      (profile?.categories || []).length > 0 ||
      (profile?.creatorTypes || []).length > 0 ||
      (profile?.skills || []).length > 0;
    if (!hasNiche) await add("NICHE_MISSING");

    const portfolio = this.portfolioUrls(profile);
    if (!portfolio.length && userType !== "Brand")
      await add("PORTFOLIO_MISSING");
    if (portfolio.some((url) => this.looksLikeScreenshot(url)))
      await add("PORTFOLIO_SCREENSHOT");
    if (portfolio.some((url) => this.looksWatermarked(url)))
      await add("PORTFOLIO_WATERMARK");
    const allPortfolioItems = this.galleryImageItems(profile);
    if (allPortfolioItems.some((item: any) => this.looksLowQuality(item)))
      await add("PORTFOLIO_LOW_QUALITY");
    const normalizedPortfolio = portfolio.map((url) => url.toLowerCase());
    if (new Set(normalizedPortfolio).size !== normalizedPortfolio.length)
      await add("PORTFOLIO_DUPLICATE");

    if (!portfolio.length) {
      // Content-specific gallery flags can't apply to an empty gallery — there are no
      // images left to be a screenshot/duplicate/watermark/low-quality. Clear any stale
      // ones (including admin-set) so moderation doesn't show a flag reason for images
      // that no longer exist; PORTFOLIO_MISSING (added above) is the only valid reason.
      await this.flagModel.updateMany(
        {
          userId: String(userId),
          userType,
          status: "Open",
          flagCode: {
            $in: [
              "PORTFOLIO_SCREENSHOT",
              "PORTFOLIO_LOW_QUALITY",
              "PORTFOLIO_DUPLICATE",
              "PORTFOLIO_WATERMARK",
            ],
          },
        },
        {
          $set: {
            status: "Resolved",
            reviewedBy: "AUTO",
            reviewedAt: new Date(),
            reviewNotes:
              "Automatically resolved: gallery has no images for this flag to apply to.",
          },
          $push: {
            auditLog: {
              action: "auto_resolved",
              actorId: "AUTO",
              actorRole: "system",
              note: "Gallery is empty; content-specific flag no longer applies.",
              actedAt: new Date(),
            },
          },
        },
      );
    }

    if (!this.isEmailVerified(profile)) await add("EMAIL_NOT_VERIFIED");
    if (!this.isMobileVerified(profile)) await add("MOBILE_NOT_VERIFIED");
    await this.flagModel.updateMany(
      {
        userId: String(userId),
        userType,
        status: "Open",
        createdBy: "AUTO",
        flagCode: {
          $in: Array.from(AUTO_FLAG_CODES),
          $nin: Array.from(desired),
        },
      },
      {
        $set: {
          status: "Resolved",
          reviewedBy: "AUTO",
          reviewedAt: new Date(),
          reviewNotes: "Automatically resolved after profile data changed.",
        },
        $push: {
          auditLog: {
            action: "auto_resolved",
            actorId: "AUTO",
            actorRole: "system",
            note: "Profile data no longer matches this automatic flag.",
            actedAt: new Date(),
          },
        },
      },
    );
  }

  async getDashboard(userId: string, role: any) {
    const { userType, profile } = await this.loadProfile(userId, role);
    await this.refreshAutomaticFlags(userId, userType, profile);
    const flags = await this.flagModel
      .find({ userId: String(userId), userType, status: "Open" })
      .sort({ severity: 1, createdAt: -1 })
      .lean();
    const completion = this.computeCompletion(profile, userType, flags);
    const qualityFlags = flags.filter(
      (flag) => !ADMIN_ONLY_FLAG_CODES.has(String(flag.flagCode || "")),
    );
    const visibleActionFlags = flags.filter(
      (flag) => !HIDDEN_ACTION_FLAG_CODES.has(String(flag.flagCode || "")),
    );
    const quality = this.qualityFromFlags(qualityFlags, completion);
    const tier =
      completion < 40
        ? "Draft"
        : profile?.adminReviewPending
          ? "Under Review"
          : quality.status;
    await this.modelForUserType(userType).findByIdAndUpdate(userId, {
      $set: {
        profileCompletion: completion,
        profileQualityScore: quality.score,
        profileQualityLabel: quality.label,
        profileTier: tier,
        mobileVerified: this.isMobileVerified(profile),
      },
    });

    return {
      userId,
      userType,
      displayName: profile?.name || profile?.brandName || profile?.email,
      profileCompletion: completion,
      profileQualityScore: quality.score,
      profileQualityLabel: quality.label,
      // Profile data-quality tier — never admin approval. See
      // verificationStatus/isTrendstarzVerified below for that.
      profileTier: tier,
      // The real admin-approval state, independent of the tier above —
      // same source isAdminApproved()/campaign eligibility uses, so a
      // screen can show both without one implying the other.
      verificationStatus: this.verificationStatusLabel(profile),
      isTrendstarzVerified: this.isAdminApproved(profile),
      verificationChecks: this.verificationChecks(profile),
      verificationBadges: this.verificationBadges(profile),
      checklist: this.checklist(profile, flags, userType),
      actionRequired: visibleActionFlags.map((flag) => ({
        id: flag._id,
        category: flag.category,
        flagCode: flag.flagCode,
        severity: flag.severity,
        message: flag.message,
        status: flag.status,
        createdAt: flag.createdAt,
      })),
      flags,
      campaignEligibility: this.buildEligibility(profile, flags, userType),
      campaignStatus: this.buildCampaignStatus(profile, flags, userType),
      profileVisibility: profile?.profileVisibility || "PUBLIC",
      featuredInMarketing: !!profile?.featuredInMarketing,
      homepageEligibility: this.buildHomepageEligibility(profile, flags, userType),
    };
  }

  /**
   * Campaign eligibility — deliberately the strictest of the three tiers
   * (Search < Welcome/Featured = Campaign). Campaigns involve real work and
   * payment, so on top of everything Welcome/Featured requires (profile
   * completeness + admin approval), email/mobile verification and photo
   * safety violations are hard blockers here too.
   */
  buildEligibility(profile: any, flags: any[], userType: ProfileUserType) {
    const blockers: string[] = [];
    const hasOpen = (code: string) =>
      flags.some((flag) => flag.flagCode === code && flag.status === "Open");
    if (profile?.status !== "accepted") blockers.push("Account is not active");
    if (!this.isEmailVerified(profile)) blockers.push("Email not verified");
    if (!this.isMobileVerified(profile)) blockers.push("Mobile not verified");
    // Only safety violations block campaign invites
    if ([...PROFILE_PHOTO_SAFETY_FLAG_CODES].some((code) => hasOpen(code))) {
      blockers.push(PROFILE_PHOTO_SAFETY_MESSAGE);
    }
    if (!this.isProfileComplete(profile, userType)) {
      blockers.push(
        userType === "Brand"
          ? "Company profile is incomplete (logo and location required)"
          : userType === "Photographer"
            ? "Profile is incomplete (photo, location, social tier, and portfolio required)"
            : "Profile is incomplete (photo, location, and social tier required)",
      );
    }
    if (!this.isAdminApproved(profile)) {
      blockers.push("Admin approval is required before campaign participation");
    }
    return { eligible: blockers.length === 0, blockers };
  }

  /**
   * Homepage Feature eligibility checklist for the admin profile-moderation
   * view. Mirrors (but is not literally shared code with) the real gating
   * conditions in applyApprovedEligibilityFilter (profile-eligibility.util.ts)
   * plus the featuredInMarketing/profileVisibility checks in
   * getHeroShowcaseInfluencerAndBrandImages / getHeroShowcasePhotographerImage
   * — if those change, update this too. isPremium is informational only
   * (ranking bonus in the real query), never a hard requirement here either.
   */
  buildHomepageEligibility(profile: any, flags: any[], userType: ProfileUserType) {
    const hasOpen = (code: string) =>
      flags.some((flag) => flag.flagCode === code && flag.status === "Open");

    const photoField = userType === "Brand" ? "brandLogo" : "profileImages";
    const hasPhoto =
      Array.isArray(profile?.[photoField]) && profile[photoField].length > 0;

    const emailVerified = this.isEmailVerified(profile);
    const mobileVerified = this.isMobileVerified(profile);
    const profilePhotoApproved =
      hasPhoto &&
      ![...PROFILE_PHOTO_VISIBILITY_BLOCK_FLAG_CODES].some((code) =>
        hasOpen(code),
      );
    const profileApproved = this.isAdminApproved(profile);
    const isPremium = !!profile?.isPremium;
    const homepageConsent = !!profile?.featuredInMarketing;
    const profileVisibility = profile?.profileVisibility || "PUBLIC";
    const visibilityIsPublic = profileVisibility === "PUBLIC";

    const reasons: string[] = [];
    if (!emailVerified) reasons.push("Email not verified");
    if (!mobileVerified) reasons.push("Mobile not verified");
    if (!profilePhotoApproved) reasons.push("Profile photo not approved");
    if (!profileApproved) reasons.push("Profile not approved by admin");
    if (!homepageConsent) reasons.push("Homepage consent disabled");
    if (!visibilityIsPublic) reasons.push("Profile visibility is not Public");

    return {
      emailVerified,
      mobileVerified,
      profilePhotoApproved,
      profileApproved,
      isPremium,
      homepageConsent,
      profileVisibility,
      eligibleForHomepage: reasons.length === 0,
      reasons,
    };
  }

  buildCampaignStatus(
    profile: any,
    flags: any[],
    userType: ProfileUserType,
  ): "eligible" | "profile_update_required" | "restricted" {
    const hasOpen = (code: string) =>
      flags.some((flag) => flag.flagCode === code && flag.status === "Open");
    // Restricted: account inactive, email/mobile unverified, safety violation, or not yet admin-approved
    if (profile?.status !== "accepted") {
      return "restricted";
    }
    if (!this.isEmailVerified(profile) || !this.isMobileVerified(profile)) {
      return "restricted";
    }
    if ([...PROFILE_PHOTO_SAFETY_FLAG_CODES].some((code) => hasOpen(code))) {
      return "restricted";
    }
    if (!this.isAdminApproved(profile)) {
      return "restricted";
    }
    // Profile update required: photo quality issues, or an incomplete profile
    if ([...PROFILE_PHOTO_VISIBILITY_BLOCK_FLAG_CODES].some((code) => hasOpen(code))) {
      return "profile_update_required";
    }
    if (!this.isProfileComplete(profile, userType)) {
      return "profile_update_required";
    }
    return "eligible";
  }

  async assertCampaignEligible(userId: string, role: any) {
    const dashboard = await this.getDashboard(userId, role);
    if (!dashboard.campaignEligibility.eligible) {
      throw new BadRequestException({
        message:
          "Profile verification is required before campaign participation.",
        blockers: dashboard.campaignEligibility.blockers,
      });
    }
  }

  async resubmit(userId: string, role: any) {
    const { userType } = await this.loadProfile(userId, role);
    await this.modelForUserType(userType).findByIdAndUpdate(userId, {
      $set: {
        adminReviewPending: true,
        profileTier: "Under Review",
      },
    });
    return this.getDashboard(userId, role);
  }

  private assertAdmin(actor: any) {
    if (String(actor?.role || "").toLowerCase() !== "admin") {
      throw new ForbiddenException("Admin access required");
    }
  }

  async listModeration(actor: any, query: any) {
    this.assertAdmin(actor);
    const page = Math.max(1, Number(query?.page || 1));
    const limit = Math.min(100, Math.max(1, Number(query?.limit || 20)));
    const statusFilter = String(query?.status || "").trim();
    const userTypes: ProfileUserType[] = [
      "Influencer",
      "Brand",
      "Photographer",
    ];
    const rows: any[] = [];

    for (const userType of userTypes) {
      const model = this.modelForUserType(userType);
      const filter: any = { isDeleted: { $ne: true } };
      if (statusFilter && statusFilter !== "all") {
        if (statusFilter === "Pending Review") filter.adminReviewPending = true;
        else if (statusFilter === "Action Required")
          filter.profileTier = "Needs Attention";
        else if (statusFilter === "Verified") {
          filter.profileTier = {
            $in: ["Good Profile", "Brand Ready", "Outstanding Profile"],
          };
        } else if (statusFilter === "Rejected")
          filter.verificationStatus = "rejected";
      }
      const users = await model
        .find(filter)
        .select(
          "name brandName email profileCompletion profileQualityScore profileTier verificationStatus adminReviewPending status updatedAt",
        )
        .sort({ updatedAt: -1 })
        .lean();
      const ids = users.map((u: any) => String(u._id));
      const counts = ids.length
        ? await this.flagModel.aggregate([
            { $match: { userType, userId: { $in: ids }, status: "Open" } },
            { $group: { _id: "$userId", count: { $sum: 1 } } },
          ])
        : [];
      const countMap = new Map(
        counts.map((item: any) => [String(item._id), item.count]),
      );
      for (const user of users) {
        rows.push({
          userId: String(user._id),
          userType,
          name: user.name || user.brandName || user.email,
          email: user.email,
          profileCompletion: user.profileCompletion || 0,
          profileQualityScore: Math.min(
            Number(user.profileQualityScore ?? 0),
            Number(user.profileCompletion ?? user.profileQualityScore ?? 0),
          ),
          profileTier: user.profileTier || "Draft",
          verificationStatus: user.verificationStatus || "",
          openFlagsCount: countMap.get(String(user._id)) || 0,
          adminReviewPending: !!user.adminReviewPending,
          updatedAt: user.updatedAt,
        });
      }
    }

    rows.sort(
      (a, b) =>
        new Date(b.updatedAt || 0).getTime() -
        new Date(a.updatedAt || 0).getTime(),
    );
    const start = (page - 1) * limit;
    return {
      items: rows.slice(start, start + limit),
      total: rows.length,
      page,
      limit,
    };
  }

  async adminDetail(actor: any, userType: ProfileUserType, userId: string) {
    this.assertAdmin(actor);
    const role =
      userType === "Brand"
        ? "brand"
        : userType === "Photographer"
          ? "photographer"
          : "influencer";
    return this.getDashboard(userId, role);
  }

  async adminAction(
    actor: any,
    userType: ProfileUserType,
    userId: string,
    body: any,
  ) {
    this.assertAdmin(actor);
    const action = String(body?.action || "").trim();
    const notes = String(body?.notes || "").trim();
    const validActions = new Set([
      "approve",
      "approve_warning",
      "request_changes",
      "reject",
    ]);
    if (!validActions.has(action))
      throw new BadRequestException("Invalid moderation action");
    const profileModel = this.modelForUserType(userType);
    const legacyAuditActions: Array<{ from: string; to: string }> = [
      { from: "approve", to: "approved" },
      { from: "reject", to: "rejected" },
      { from: "request_changes", to: "status_changed" },
    ];
    for (const legacy of legacyAuditActions) {
      await profileModel.updateOne(
        {
          _id: this.objectIdOrString(userId),
          "verificationAuditLog.action": legacy.from,
        },
        { $set: { "verificationAuditLog.$[entry].action": legacy.to } },
        { arrayFilters: [{ "entry.action": legacy.from }] },
      );
    }
    const auditAction =
      action === "approve" || action === "approve_warning"
        ? "approved"
        : action === "request_changes"
          ? "status_changed"
          : action === "reject"
            ? "rejected"
            : action;
    const auditStatus =
      action === "reject"
        ? "rejected"
        : action === "request_changes"
          ? "pending"
          : "approved";
    await profileModel.findByIdAndUpdate(userId, {
      $set: {
        adminReviewPending: false,
        profileModerationNotes: notes,
        verificationAdminNotes: notes,
        ...(action === "approve" || action === "approve_warning"
          ? {
              verifiedByTrendStarz: true,
              verificationStatus: "approved",
              approvedAt: new Date(),
            }
          : {}),
        ...(action === "reject" ? { verificationStatus: "rejected" } : {}),
      },
      $push: {
        verificationAuditLog: {
          action: auditAction,
          status: auditStatus,
          note: notes,
          actorId: String(actor?.userId || actor?.id || ""),
          actorRole: "admin",
          actedAt: new Date(),
        },
      },
    });
    if (action === "approve" || action === "approve_warning") {
      const reviewer = String(
        actor?.name || actor?.email || actor?.userId || "TrendStarz Team",
      );
      // Clear ALL open photo flags (quality + policy + pending-review) so the
      // profile is immediately unblocked from search and campaign invite lists.
      await this.flagModel.updateMany(
        {
          userId: String(userId),
          userType,
          status: "Open",
          flagCode: { $in: Array.from(PROFILE_PHOTO_ADMIN_REVIEW_FLAG_CODES) },
        },
        {
          $set: {
            status: "Resolved",
            reviewedBy: reviewer,
            reviewedAt: new Date(),
            reviewNotes: notes || "Profile approved by admin — photo accepted.",
          },
          $push: {
            auditLog: {
              action: "resolved",
              actorId: String(actor?.userId || actor?.id || ""),
              actorRole: "admin",
              note: notes || "Profile approved by admin.",
              actedAt: new Date(),
            },
          },
        },
      );
      // Mark photo and tier as verified so re-upload / tier-change auto-verify
      // from here on — until admin explicitly unverifies either.
      await profileModel.findByIdAndUpdate(userId, {
        $set: { profilePhotoVerified: true, creatorTierVerified: true },
      });
    }
    return this.adminDetail(actor, userType, userId);
  }

  async updateVerificationChecks(
    actor: any,
    userType: ProfileUserType,
    userId: string,
    body: any,
  ) {
    this.assertAdmin(actor);
    const allowed = [
      "verificationCallCompleted",
      "identityVerified",
      "identityConfirmed",
      "locationVerified",
      "socialVerified",
      "socialProfilesReviewed",
      "paymentVerified",
      "panVerified",
    ];
    const set: any = {
      lastReviewedAt: new Date(),
      reviewedBy: String(
        actor?.name || actor?.email || actor?.userId || "TrendStarz Team",
      ),
    };
    for (const key of allowed) {
      if (typeof body?.[key] !== "boolean") continue;
      set[key] = body[key];
      const atKey =
        key === "identityConfirmed"
          ? "identityVerifiedAt"
          : key === "socialProfilesReviewed"
            ? "socialProfilesReviewedAt"
            : `${key}At`;
      set[atKey] = body[key] ? new Date() : null;
    }
    if (typeof body?.identityVerified === "boolean") {
      set.identityConfirmed = body.identityVerified;
      set.verifiedByAdmin = body.identityVerified
        ? String(
            actor?.name || actor?.email || actor?.userId || "TrendStarz Team",
          )
        : "";
    }
    if (typeof body?.identityConfirmed === "boolean") {
      set.identityVerified = body.identityConfirmed;
      set.verifiedByAdmin = body.identityConfirmed
        ? String(
            actor?.name || actor?.email || actor?.userId || "TrendStarz Team",
          )
        : "";
    }
    if (typeof body?.socialVerified === "boolean") {
      set.socialProfilesReviewed = body.socialVerified;
      set.socialProfilesReviewedAt = body.socialVerified ? new Date() : null;
    }
    if (typeof body?.socialProfilesReviewed === "boolean") {
      set.socialVerified = body.socialProfilesReviewed;
      set.socialVerifiedAt = body.socialProfilesReviewed ? new Date() : null;
    }
    await this.modelForUserType(userType).findByIdAndUpdate(userId, {
      $set: set,
    });

    if (typeof body?.profilePhotoVerified === "boolean") {
      const reviewer = String(
        actor?.name || actor?.email || actor?.userId || "TrendStarz Team",
      );
      if (body.profilePhotoVerified) {
        // Resolve all photo flags (quality + policy)
        await this.flagModel.updateMany(
          {
            userId: String(userId),
            userType,
            status: "Open",
            flagCode: {
              $in: Array.from(PROFILE_PHOTO_ADMIN_REVIEW_FLAG_CODES),
            },
          },
          {
            $set: {
              status: "Resolved",
              reviewedBy: reviewer,
              reviewedAt: new Date(),
              reviewNotes: "Profile photo verified by admin.",
            },
            $push: {
              auditLog: {
                action: "resolved",
                actorId: String(actor?.userId || actor?.id || ""),
                actorRole: "admin",
                note: "Profile photo verified by admin.",
                actedAt: new Date(),
              },
            },
          },
        );
      } else {
        // Specific flag code if provided, otherwise generic quality
        const isPolicy = PHOTO_POLICY_CODES_SET.has(body.photoFlagCode);
        const flagCode = isPolicy
          ? body.photoFlagCode
          : PHOTO_QUALITY_CODES.has(body.photoFlagCode)
            ? body.photoFlagCode
            : "PROFILE_PHOTO_QUALITY";
        const severity = isPolicy ? "High" : "Medium";
        const message = PHOTO_FLAG_MESSAGES[flagCode] || PROFILE_PHOTO_QUALITY_MESSAGE;
        // Close all existing photo flags first so only ONE flag is ever active
        await this.flagModel.updateMany(
          {
            userId: String(userId),
            userType,
            status: "Open",
            flagCode: { $in: Array.from(PROFILE_PHOTO_ADMIN_REVIEW_FLAG_CODES), $ne: flagCode },
          },
          {
            $set: {
              status: "Resolved",
              reviewedBy: reviewer,
              reviewedAt: new Date(),
              reviewNotes: `Superseded by new flag (${flagCode}).`,
            },
            $push: {
              auditLog: {
                action: "resolved",
                actorId: String(actor?.userId || actor?.id || ""),
                actorRole: "admin",
                note: `Superseded by new flag (${flagCode}).`,
                actedAt: new Date(),
              },
            },
          },
        );
        await this.flagModel.updateOne(
          { userId: String(userId), userType, flagCode, status: "Open" },
          {
            $setOnInsert: {
              createdAt: new Date(),
              auditLog: [{
                action: "created",
                actorId: String(actor?.userId || actor?.id || ""),
                actorRole: "admin",
                note: `Profile photo flagged (${flagCode}) by admin.`,
                actedAt: new Date(),
              }],
            },
            $set: {
              category: "Identity",
              severity,
              message,
              createdBy: "ADMIN",
              reviewedBy: reviewer,
              reviewedAt: new Date(),
              reviewNotes: `Profile photo flagged (${flagCode}) by admin.`,
            },
          },
          { upsert: true },
        );
      }
    }

    if (typeof body?.photoPolicy === "boolean") {
      const reviewer = String(
        actor?.name || actor?.email || actor?.userId || "TrendStarz Team",
      );
      if (!body.photoPolicy) {
        // Clear all photo policy/safety flags
        await this.flagModel.updateMany(
          {
            userId: String(userId),
            userType,
            status: "Open",
            flagCode: { $in: Array.from(PROFILE_PHOTO_POLICY_FLAG_CODES) },
          },
          {
            $set: {
              status: "Resolved",
              reviewedBy: reviewer,
              reviewedAt: new Date(),
              reviewNotes: "Photo policy flag cleared by admin.",
            },
            $push: {
              auditLog: {
                action: "resolved",
                actorId: String(actor?.userId || actor?.id || ""),
                actorRole: "admin",
                note: "Photo policy flag cleared by admin.",
                actedAt: new Date(),
              },
            },
          },
        );
      } else {
        const policyCode = PHOTO_POLICY_CODES_SET.has(body.photoFlagCode) ? body.photoFlagCode : "PROFILE_PHOTO_POLICY";
        // Close all other photo flags (quality + other policy) — only one flag at a time
        await this.flagModel.updateMany(
          {
            userId: String(userId),
            userType,
            status: "Open",
            flagCode: { $in: Array.from(PROFILE_PHOTO_ADMIN_REVIEW_FLAG_CODES), $ne: policyCode },
          },
          {
            $set: {
              status: "Resolved",
              reviewedBy: reviewer,
              reviewedAt: new Date(),
              reviewNotes: `Superseded by policy flag (${policyCode}).`,
            },
            $push: {
              auditLog: {
                action: "resolved",
                actorId: String(actor?.userId || actor?.id || ""),
                actorRole: "admin",
                note: `Superseded by policy flag (${policyCode}).`,
                actedAt: new Date(),
              },
            },
          },
        );
        await this.flagModel.updateOne(
          { userId: String(userId), userType, flagCode: policyCode, status: "Open" },
          {
            $setOnInsert: {
              createdAt: new Date(),
              auditLog: [{
                action: "created",
                actorId: String(actor?.userId || actor?.id || ""),
                actorRole: "admin",
                note: `Photo policy violation (${policyCode}) flagged by admin.`,
                actedAt: new Date(),
              }],
            },
            $set: {
              category: "Identity",
              severity: "High",
              message: PHOTO_FLAG_MESSAGES[policyCode] || PROFILE_PHOTO_SAFETY_MESSAGE,
              createdBy: "ADMIN",
              reviewedBy: reviewer,
              reviewedAt: new Date(),
              reviewNotes: `Photo policy violation (${policyCode}) flagged by admin.`,
            },
          },
          { upsert: true },
        );
      }
    }

    if (typeof body?.galleryImagesVerified === "boolean") {
      const reviewer = String(actor?.name || actor?.email || actor?.userId || "TrendStarz Team");
      if (body.galleryImagesVerified) {
        await this.flagModel.updateMany(
          {
            userId: String(userId),
            userType,
            status: "Open",
            flagCode: { $in: Array.from(GALLERY_FLAG_CODES_SET) },
          },
          {
            $set: {
              status: "Resolved",
              reviewedBy: reviewer,
              reviewedAt: new Date(),
              reviewNotes: "Gallery images verified by admin.",
            },
            $push: {
              auditLog: {
                action: "resolved",
                actorId: String(actor?.userId || actor?.id || ""),
                actorRole: "admin",
                note: "Gallery images verified by admin.",
                actedAt: new Date(),
              },
            },
          },
        );
      } else {
        const galleryCode = GALLERY_FLAG_CODES_SET.has(body.galleryFlagCode) ? body.galleryFlagCode : "PORTFOLIO_LOW_QUALITY";
        // Close all other gallery flags first — only one flag active at a time
        await this.flagModel.updateMany(
          {
            userId: String(userId),
            userType,
            status: "Open",
            flagCode: { $in: Array.from(GALLERY_FLAG_CODES_SET), $ne: galleryCode },
          },
          {
            $set: {
              status: "Resolved",
              reviewedBy: reviewer,
              reviewedAt: new Date(),
              reviewNotes: `Superseded by new gallery flag (${galleryCode}).`,
            },
            $push: {
              auditLog: {
                action: "resolved",
                actorId: String(actor?.userId || actor?.id || ""),
                actorRole: "admin",
                note: `Superseded by new gallery flag (${galleryCode}).`,
                actedAt: new Date(),
              },
            },
          },
        );
        await this.flagModel.updateOne(
          { userId: String(userId), userType, flagCode: galleryCode, status: "Open" },
          {
            $setOnInsert: {
              createdAt: new Date(),
              auditLog: [{
                action: "created",
                actorId: String(actor?.userId || actor?.id || ""),
                actorRole: "admin",
                note: `Gallery flagged (${galleryCode}) by admin.`,
                actedAt: new Date(),
              }],
            },
            $set: {
              category: "Portfolio",
              severity: "Medium",
              message: GALLERY_FLAG_MESSAGES[galleryCode] || GALLERY_FLAG_MESSAGES["PORTFOLIO_LOW_QUALITY"],
              createdBy: "ADMIN",
              reviewedBy: reviewer,
              reviewedAt: new Date(),
              reviewNotes: `Gallery flagged (${galleryCode}) by admin.`,
            },
          },
          { upsert: true },
        );
      }
    }

    return this.adminDetail(actor, userType, userId);
  }

  async addFlag(
    actor: any,
    userType: ProfileUserType,
    userId: string,
    body: any,
  ) {
    this.assertAdmin(actor);
    const flagCode = String(body?.flagCode || "").trim();
    const meta = FLAG_META[flagCode] || {};
    const flag = await this.flagModel.create({
      userId: String(userId),
      userType,
      category: body?.category || meta.category || "Identity",
      flagCode,
      severity: body?.severity || meta.severity || "Low",
      message: body?.message || meta.message || flagCode,
      status: "Open",
      createdBy: "ADMIN",
      auditLog: [
        {
          action: "created",
          actorId: String(actor?.userId || actor?.id || ""),
          actorRole: "admin",
          note: body?.reviewNotes || "",
          actedAt: new Date(),
        },
      ],
    });

    if (PHOTO_FLAG_MESSAGES[flagCode]) {
      await this.notifyProfilePhotoFlagged(userType, userId).catch(() => {});
    }

    return flag;
  }

  /**
   * Nudges a fully-verified user by WhatsApp when admin/support manually
   * flags their profile photo as not meeting guidelines (via addFlag above —
   * photo review is manual, there is no automated check at upload time).
   * Only fires once the user's email AND mobile are both already verified,
   * matching the "Your email and mobile number are verified" copy. Best-effort:
   * a delivery failure here must never block the admin's flagging action.
   *
   * profile_photo_not_verified template body to submit in Meta Business
   * Manager → WhatsApp Manager → Message Templates (category: Utility,
   * 1 body param — display name):
   *
   *   Hi {{1}}, your email and mobile number are verified.
   *
   *   However, your profile photo does not meet our profile guidelines.
   *   Please update your profile photo to make your profile visible to
   *   brands on TrendStarZ.
   *
   *   Login and update your profile photo to complete your profile:
   *   www.trendstarz.in
   */
  private async notifyProfilePhotoFlagged(
    userType: ProfileUserType,
    userId: string,
  ) {
    const profile = await this.modelForUserType(userType)
      .findById(userId)
      .lean();
    if (!profile) return;
    if (!this.isEmailVerified(profile) || !this.isMobileVerified(profile)) return;

    const displayName =
      (profile as any).name ||
      (profile as any).brandName ||
      (profile as any).contactPersonName ||
      "there";

    await this.whatsAppService.sendToUser(
      String(userId),
      (profile as any).phoneNumber,
      this.isMobileVerified(profile),
      {
        name: "profile_photo_not_verified",
        bodyParams: [displayName],
      },
    );
  }

  async updateFlag(actor: any, flagId: string, body: any) {
    this.assertAdmin(actor);
    const flag = await this.flagModel.findById(flagId);
    if (!flag) throw new NotFoundException("Flag not found");
    if (body?.status) flag.status = body.status;
    if (body?.severity) flag.severity = body.severity;
    if (body?.message) flag.message = body.message;
    flag.reviewedBy = String(actor?.userId || actor?.id || "");
    flag.reviewedAt = new Date();
    flag.reviewNotes = String(body?.reviewNotes || flag.reviewNotes || "");
    flag.auditLog = [
      ...(Array.isArray(flag.auditLog) ? flag.auditLog : []),
      {
        action: body?.status ? `status:${body.status}` : "updated",
        actorId: flag.reviewedBy,
        actorRole: "admin",
        note: flag.reviewNotes,
        actedAt: new Date(),
      },
    ];
    const saved = await flag.save();
    if (
      flag.flagCode === "PROFILE_PHOTO_PENDING_REVIEW" &&
      flag.status === "Resolved"
    ) {
      await this.modelForUserType(
        flag.userType as ProfileUserType,
      ).findByIdAndUpdate(flag.userId, {
        $set: {
          adminReviewPending: false,
        },
      });
    }
    return saved;
  }

  /**
   * Admin override for Profile Visibility / Homepage Feature — support staff
   * use this during manual verification calls (see buildHomepageEligibility
   * for the read-only eligibility checklist shown alongside it).
   */
  async adminUpdateVisibility(
    actor: any,
    userType: ProfileUserType,
    userId: string,
    body: { profileVisibility?: string; featuredInMarketing?: boolean },
  ) {
    this.assertAdmin(actor);
    const update: any = {};
    if (body?.profileVisibility !== undefined) {
      const allowed = ["PUBLIC", "MEMBERS_ONLY", "PRIVATE"];
      const value = String(body.profileVisibility).toUpperCase();
      if (!allowed.includes(value)) {
        throw new BadRequestException(
          "profileVisibility must be one of PUBLIC, MEMBERS_ONLY, PRIVATE",
        );
      }
      update.profileVisibility = value;
      if (value !== "PUBLIC") update.featuredInMarketing = false;
    }
    if (
      typeof body?.featuredInMarketing === "boolean" &&
      update.featuredInMarketing === undefined
    ) {
      update.featuredInMarketing = body.featuredInMarketing;
    }
    if (Object.keys(update).length > 0) {
      await this.modelForUserType(userType).findByIdAndUpdate(userId, {
        $set: update,
      });
    }
    return this.adminDetail(actor, userType, userId);
  }

  private async sendMobileWhatsAppNudge(
    actor: any,
    userType: ProfileUserType,
    userId: string,
    templateName: "mobile_otp_verification_reminder" | "mobile_verification_call_reminder",
  ) {
    this.assertAdmin(actor);
    const profile = await this.modelForUserType(userType)
      .findById(userId)
      .select("name brandName phoneNumber")
      .lean();
    if (!profile) throw new NotFoundException("User not found");

    const displayName =
      (profile as any).name || (profile as any).brandName || "there";
    const phoneNumber = (profile as any).phoneNumber;

    const result = await this.whatsAppService.sendVerificationNudge(
      userId,
      phoneNumber,
      {
        name: templateName,
        bodyParams: [displayName, String(phoneNumber || "")],
      },
    );
    if (!result.sent) {
      throw new BadRequestException(
        result.reason || "Failed to send WhatsApp reminder",
      );
    }
    return result;
  }

  /**
   * Admin "Send OTP Reminder" — the first-line nudge, pointing the user back
   * to self-service OTP verification. Deliberately uses sendVerificationNudge
   * (not sendToUser), since the number being messaged is exactly the one
   * that isn't verified yet.
   *
   * mobile_otp_verification_reminder template body to submit in Meta
   * Business Manager → WhatsApp Manager → Message Templates (category:
   * Utility, 2 body params — display name, phone number):
   *
   *   Hi {{1}},
   *
   *   Your TrendStarZ mobile number {{2}} is still pending verification.
   *
   *   Please log in to your TrendStarZ account and complete the mobile
   *   verification using the OTP sent to your registered mobile number.
   *
   *   If you need a new OTP, you can request one from the verification screen.
   *
   *   Thank you for joining TrendStarZ! 💜
   */
  async sendMobileOtpVerificationReminder(
    actor: any,
    userType: ProfileUserType,
    userId: string,
  ) {
    return this.sendMobileWhatsAppNudge(
      actor,
      userType,
      userId,
      "mobile_otp_verification_reminder",
    );
  }

  /**
   * Admin "Request Manual Call" — the fallback once OTP self-verification
   * hasn't worked out (a few unsuccessful attempts, or the user asks for
   * help): asks the user to reply YES so a manual verification call can be
   * made to their registered mobile number.
   *
   * mobile_verification_call_reminder template body to submit in Meta
   * Business Manager → WhatsApp Manager → Message Templates (category:
   * Utility, 2 body params — display name, phone number):
   *
   *   Hi {{1}},
   *
   *   Your TrendStarZ mobile number {{2}} is still pending verification.
   *
   *   Please reply YES when you're available. Our team will call your
   *   registered mobile number to complete the verification process.
   *
   *   Thank you for joining TrendStarZ! 💜
   */
  async sendMobileVerificationReminder(
    actor: any,
    userType: ProfileUserType,
    userId: string,
  ) {
    return this.sendMobileWhatsAppNudge(
      actor,
      userType,
      userId,
      "mobile_verification_call_reminder",
    );
  }
}
