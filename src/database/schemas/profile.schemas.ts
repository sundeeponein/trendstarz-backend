import { Schema, Types, model } from "mongoose";

export const TierSchema = new Schema({
  name: { type: String, required: true },
  icon: { type: String },
  desc: { type: String },
  showInFrontend: { type: Boolean, default: true },
});
export const TierModel = model("Tier", TierSchema);

// Language schema
export const LanguageSchema = new Schema({
  name: { type: String, required: true },
  showInFrontend: { type: Boolean, default: true },
});
export const LanguageModel = model("Language", LanguageSchema);

// User schema (for admin and future users)
export const UserSchema = new Schema(
  {
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    firebaseUid: { type: String, default: null, index: true },
    password: { type: String, required: true },
    role: { type: String, enum: ["admin", "user"], default: "user" },
    firstRegisteredAt: { type: Date, default: Date.now },
    lastLoginAt: { type: Date, default: null },
    isEmailVerified: { type: Boolean, default: false },
    isMobileVerified: { type: Boolean, default: false },
    resetToken: { type: String, default: null },
    resetTokenExpires: { type: Number, default: null },
  },
  { timestamps: true },
);
UserSchema.index({ resetToken: 1 }, { sparse: true });
export const UserModel = model("User", UserSchema);

// All schema definitions go here (LanguageSchema, UserSchema, etc.)
export const InfluencerSchema = new Schema(
  {
    password: { type: String, required: true },
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    firebaseUid: { type: String, default: null, index: true },
    phoneNumber: { type: String, required: true },
    username: { type: String, required: true, unique: true },
    isEmailVerified: { type: Boolean, default: false },
    isMobileVerified: { type: Boolean, default: false },
    firstRegisteredAt: { type: Date, default: Date.now },
    lastLoginAt: { type: Date, default: null },
    profileImages: [
      {
        url: { type: String, required: true },
        public_id: { type: String, required: true },
      },
    ], // Cloudinary image objects
    // Soft delete and media fields
    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date },
    profileImage: { type: String },
    profileImagePublicId: { type: String },
    galleryImages: [
      {
        url: String,
        publicId: String,
      },
    ],
    isPremium: { type: Boolean, default: false },
    premiumDuration: {
      type: String,
      enum: ["1m", "3m", "1y", null],
      default: null,
    }, // 1 month, 3 months, 1 year
    premiumStart: { type: Date, default: null },
    premiumEnd: { type: Date, default: null },
    categories: [{ type: String }],
    influencerCategory: { type: String, default: "" },
    creatorTypes: [{ type: String }],
    professionalStatus: { type: Boolean, default: false },
    expertiseArea: { type: String, default: "" },
    verificationDocuments: [
      {
        url: { type: String, required: true },
        public_id: { type: String, required: true },
        originalName: { type: String, default: "" },
        mimeType: { type: String, default: "" },
        uploadedAt: { type: Date, default: Date.now },
      },
    ],
    verificationStatus: {
      type: String,
      enum: ["not_submitted", "pending", "approved", "rejected", "removed"],
      default: "not_submitted",
    },
    verificationDisclaimerAccepted: { type: Boolean, default: false },
    verificationAdminNotes: { type: String, default: "" },
    verifiedByTrendStarz: { type: Boolean, default: false },
    verificationAuditLog: [
      {
        action: {
          type: String,
          enum: [
            "submitted",
            "approved",
            "rejected",
            "removed",
            "status_changed",
            "notes_updated",
          ],
          required: true,
        },
        status: {
          type: String,
          enum: ["not_submitted", "pending", "approved", "rejected", "removed"],
          default: "not_submitted",
        },
        note: { type: String, default: "" },
        actorId: { type: String, default: "" },
        actorRole: { type: String, default: "" },
        actedAt: { type: Date, default: Date.now },
      },
    ],
    languages: [{ type: String }],
    adminTags: [{ type: String }],
    dateOfBirth: { type: Date, default: null },
    gender: { type: String, default: "" },
    location: {
      state: { type: String },
      district: { type: String },
    },
    socialMedia: [
      {
        platform: { type: String },
        handle: { type: String },
        tier: { type: String },
        followersCount: { type: Number },
        contentTypes: [
          {
            name: { type: String },
            enabled: { type: Boolean, default: false },
            price: { type: Number, default: 0 },
          },
        ],
      },
    ],
    collaborationAvailability: {
      enabled: { type: Boolean, default: false },
      collaborationTypes: [{ type: String }],
      preference: { type: String, default: "" },
      availableFor: [{ type: String }],
      openToTravel: { type: Boolean, default: false },
    },
    contact: {
      whatsapp: { type: Boolean, default: false },
      email: { type: Boolean, default: false },
      call: { type: Boolean, default: false },
    },
    signupAttribution: {
      source: { type: String },
      audience: { type: String },
      referrerPath: { type: String },
      capturedAt: { type: Date },
    },
    profileTraffic: {
      impressions: { type: Number, default: 0 },
      clicks: { type: Number, default: 0 },
      lastImpressionAt: { type: Date, default: null },
      lastClickAt: { type: Date, default: null },
    },
    promotionalPrice: { type: Number },
    website: { type: String },
    // Payout details (where admin sends earned money)
    payout: {
      upiId: { type: String, default: "" },
      mobile: { type: String, default: "" },
      accountHolderName: { type: String, default: "" },
      lastConfirmedAt: { type: Date, default: null },
    },
    // Commission override for early access, partners, premium creators
    commissionOverride: {
      enabled: { type: Boolean, default: false },
      overrideType: {
        type: String,
        enum: ["waiver", "discount", "fixed"],
        default: "discount",
      },
      value: { type: Number, default: 0 }, // For discount/fixed: percentage or amount
      validFrom: { type: Date, default: null },
      validUntil: { type: Date, default: null },
      notes: { type: String, default: "" },
      source: { type: String, default: "" },
      assignedBy: { type: String, default: "" },
      autoGenerated: { type: Boolean, default: false },
      assignedAt: { type: Date, default: null },
    },
    // Commission badge/tag for categorization
    commissionBadge: {
      type: String,
      enum: [
        "early_access_creator",
        "zero_commission_creator",
        "premium_creator",
        "partner_creator",
        "featured_creator",
        "internal_test_creator",
        null,
      ],
      default: null,
    },
    status: {
      type: String,
      enum: ["pending", "accepted", "declined", "deleted"],
      default: "pending",
    },
    resetToken: { type: String, default: null },
    resetTokenExpires: { type: Number, default: null },
  },
  { timestamps: true },
);
InfluencerSchema.index({ categories: 1 });
InfluencerSchema.index({ verificationStatus: 1 });
InfluencerSchema.index({ "location.state": 1 });
InfluencerSchema.index({ "location.district": 1 });
InfluencerSchema.index({ resetToken: 1 }, { sparse: true });
InfluencerSchema.index({ commissionBadge: 1 });

export const InfluencerModel = model("Influencer", InfluencerSchema);

export const BrandSchema = new Schema(
  {
    socialMedia: [
      {
        platform: { type: String },
        handle: { type: String },
        tier: { type: String },
        followersCount: { type: Number },
        contentTypes: [
          {
            name: { type: String },
            enabled: { type: Boolean, default: false },
            price: { type: Number, default: 0 },
          },
        ],
      },
    ],
    googleMapAddress: { type: String },
    password: { type: String, required: true },
    brandName: { type: String, required: true },
    contactPersonName: { type: String, default: "" },
    foundedYear: { type: Number, default: null },
    companySize: { type: String, default: "" },
    brandUsername: { type: String },
    email: { type: String, required: true, unique: true },
    firebaseUid: { type: String, default: null, index: true },
    phoneNumber: { type: String, required: true },
    isEmailVerified: { type: Boolean, default: false },
    isMobileVerified: { type: Boolean, default: false },
    firstRegisteredAt: { type: Date, default: Date.now },
    lastLoginAt: { type: Date, default: null },
    brandLogo: [
      {
        url: { type: String, required: true },
        public_id: { type: String, required: true },
      },
    ], // Cloudinary image objects
    // Soft delete and media fields
    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date },
    profileImage: { type: String },
    profileImagePublicId: { type: String },
    galleryImages: [
      {
        url: String,
        publicId: String,
      },
    ],
    isPremium: { type: Boolean, default: false },
    premiumDuration: {
      type: String,
      enum: ["1m", "3m", "1y", null],
      default: null,
    },
    premiumStart: { type: Date, default: null },
    premiumEnd: { type: Date, default: null },
    categories: [{ type: String }],
    languages: [{ type: String }],
    adminTags: [{ type: String }],
    website: { type: String },
    location: {
      state: { type: String },
      district: { type: String },
      googleMapLink: { type: String },
    },
    products: [
      {
        url: { type: String, required: true },
        public_id: { type: String, required: true },
      },
    ], // For premium brands, up to 3 product images
    contact: {
      whatsapp: { type: Boolean, default: false },
      email: { type: Boolean, default: false },
      call: { type: Boolean, default: false },
    },
    signupAttribution: {
      source: { type: String },
      audience: { type: String },
      referrerPath: { type: String },
      capturedAt: { type: Date },
    },
    profileTraffic: {
      impressions: { type: Number, default: 0 },
      clicks: { type: Number, default: 0 },
      lastImpressionAt: { type: Date, default: null },
      lastClickAt: { type: Date, default: null },
    },
    promotionalPrice: { type: Number },
    verifiedByTrendStarz: { type: Boolean, default: false },
    // Payout details (used for pay_to_join campaigns where brand receives money)
    payout: {
      upiId: { type: String, default: "" },
      mobile: { type: String, default: "" },
      accountHolderName: { type: String, default: "" },
      lastConfirmedAt: { type: Date, default: null },
    },
    // Commission override for early access, partners, premium creators
    commissionOverride: {
      enabled: { type: Boolean, default: false },
      overrideType: {
        type: String,
        enum: ["waiver", "discount", "fixed"],
        default: "discount",
      },
      value: { type: Number, default: 0 }, // For discount/fixed: percentage or amount
      validFrom: { type: Date, default: null },
      validUntil: { type: Date, default: null },
      notes: { type: String, default: "" },
      source: { type: String, default: "" },
      assignedBy: { type: String, default: "" },
      autoGenerated: { type: Boolean, default: false },
      assignedAt: { type: Date, default: null },
    },
    // Commission badge/tag for categorization
    commissionBadge: {
      type: String,
      enum: [
        "early_access_brand",
        "launch_partner",
        "zero_commission_brand",
        "partner_brand",
        "verified_brand",
        "premium_brand",
        "internal_test_brand",
        null,
      ],
      default: null,
    },
    status: {
      type: String,
      enum: ["pending", "accepted", "declined", "deleted"],
      default: "pending",
    },
    // Growth: 1 free contact-unlock per brand before requiring premium/payment
    freeUnlocksUsed: { type: Number, default: 0 },
    resetToken: { type: String, default: null },
    resetTokenExpires: { type: Number, default: null },
  },
  { timestamps: true },
);
BrandSchema.index({ status: 1 });
BrandSchema.index({ brandName: 1 });
BrandSchema.index({ resetToken: 1 }, { sparse: true });
BrandSchema.index({ commissionBadge: 1 });

export const BrandModel = model("Brand", BrandSchema);

// Photographer / Videographer schema
export const PhotographerSchema = new Schema(
  {
    password: { type: String, required: true },
    name: { type: String, required: true },
    username: { type: String, default: "" },
    email: { type: String, required: true, unique: true },
    firebaseUid: { type: String, default: null, index: true },
    phoneNumber: { type: String, required: true },
    isEmailVerified: { type: Boolean, default: false },
    isMobileVerified: { type: Boolean, default: false },
    firstRegisteredAt: { type: Date, default: Date.now },
    lastLoginAt: { type: Date, default: null },
    profileImages: [
      {
        url: { type: String, required: true },
        public_id: { type: String, required: true },
      },
    ],
    profileImage: { type: String },
    profileImagePublicId: { type: String },
    dateOfBirth: { type: Date, default: null },
    gender: { type: String, default: "" },
    portfolio: { type: String, default: "" }, // optional website/portfolio URL
    location: {
      state: { type: String, default: "" },
      district: { type: String, default: "" },
    },
    // Skill chips: e.g. "Fashion Photography", "Reels", "Drone"
    skills: [{ type: String }],
    // Pricing options: each entry has name, enabled flag, and price
    pricing: [
      {
        name: { type: String }, // e.g. "Starting Price", "Per Reel", "Per Shoot", "Hourly", "Equipment"
        enabled: { type: Boolean, default: false },
        price: { type: Number, default: 0 },
      },
    ],
    // Equipment chips: e.g. "Sony", "Canon", "DJI", "iPhone Creator"
    equipment: [{ type: String }],
    // Social platforms for trust (at least one required before inviting/hiring)
    socialMedia: [
      {
        platform: { type: String },
        handle: { type: String },
        tier: { type: String },
        followersCount: { type: Number },
      },
    ],
    collaborationAvailability: {
      enabled: { type: Boolean, default: false },
      availableFor: [{ type: String }],
      preference: { type: String, default: "" },
      openToTravel: { type: Boolean, default: false },
    },
    contact: {
      whatsapp: { type: Boolean, default: false },
      email: { type: Boolean, default: false },
      call: { type: Boolean, default: false },
    },
    payout: {
      upiId: { type: String, default: "" },
      mobile: { type: String, default: "" },
      accountHolderName: { type: String, default: "" },
      lastConfirmedAt: { type: Date, default: null },
    },
    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date },
    status: {
      type: String,
      enum: ["pending", "accepted", "declined", "deleted"],
      default: "pending",
    },
    signupAttribution: {
      source: { type: String },
      audience: { type: String },
      referrerPath: { type: String },
      capturedAt: { type: Date },
    },
    profileTraffic: {
      impressions: { type: Number, default: 0 },
      clicks: { type: Number, default: 0 },
      lastImpressionAt: { type: Date, default: null },
      lastClickAt: { type: Date, default: null },
    },
    resetToken: { type: String, default: null },
    resetTokenExpires: { type: Number, default: null },
    isPremium: { type: Boolean, default: false },
    premiumDuration: {
      type: String,
      enum: ["1m", "3m", "1y", null],
      default: null,
    },
    premiumStart: { type: Date, default: null },
    premiumEnd: { type: Date, default: null },
    adminTags: [{ type: String }],
    commissionOverride: {
      enabled: { type: Boolean, default: false },
      overrideType: {
        type: String,
        enum: ["waiver", "discount", "fixed"],
        default: "discount",
      },
      value: { type: Number, default: 0 },
      validFrom: { type: Date, default: null },
      validUntil: { type: Date, default: null },
      notes: { type: String, default: "" },
      source: { type: String, default: "" },
      assignedBy: { type: String, default: "" },
      autoGenerated: { type: Boolean, default: false },
      assignedAt: { type: Date, default: null },
    },
    commissionBadge: {
      type: String,
      enum: [
        "early_access_creator",
        "zero_commission_creator",
        "premium_creator",
        "partner_creator",
        "featured_creator",
        "internal_test_creator",
        null,
      ],
      default: null,
    },
    verificationDocuments: [
      {
        url: { type: String, required: true },
        public_id: { type: String, required: true },
        originalName: { type: String, default: "" },
        mimeType: { type: String, default: "" },
        uploadedAt: { type: Date, default: Date.now },
      },
    ],
    verificationStatus: {
      type: String,
      enum: ["not_submitted", "pending", "approved", "rejected", "removed"],
      default: "not_submitted",
    },
    verificationDisclaimerAccepted: { type: Boolean, default: false },
    verificationAdminNotes: { type: String, default: "" },
    verifiedByTrendStarz: { type: Boolean, default: false },
    verificationAuditLog: [
      {
        action: {
          type: String,
          enum: [
            "submitted",
            "approved",
            "rejected",
            "removed",
            "status_changed",
            "notes_updated",
          ],
          required: true,
        },
        status: {
          type: String,
          enum: ["not_submitted", "pending", "approved", "rejected", "removed"],
          default: "not_submitted",
        },
        note: { type: String, default: "" },
        actorId: { type: String, default: "" },
        actorRole: { type: String, default: "" },
        actedAt: { type: Date, default: Date.now },
      },
    ],
  },
  { timestamps: true },
);
PhotographerSchema.index({ status: 1 });
PhotographerSchema.index({ skills: 1 });
PhotographerSchema.index({ "location.state": 1 });
PhotographerSchema.index({ resetToken: 1 }, { sparse: true });
PhotographerSchema.index({ commissionBadge: 1 });

export const PhotographerModel = model("Photographer", PhotographerSchema);

export const AppSettingsSchema = new Schema({
  preApproveInfluencers: { type: Boolean, default: false },
  influencerRequireEmailVerified: { type: Boolean, default: true },
  influencerRequireMobileVerified: { type: Boolean, default: false },
  preApproveBrands: { type: Boolean, default: false },
  brandRequireEmailVerified: { type: Boolean, default: true },
  brandRequireMobileVerified: { type: Boolean, default: false },
  preApprovePhotographers: { type: Boolean, default: false },
  photographerRequireEmailVerified: { type: Boolean, default: true },
  photographerRequireMobileVerified: { type: Boolean, default: false },
  pendingUserAutoDeleteEnabled: { type: Boolean, default: false },
  pendingUserAutoDeleteDays: { type: Number, default: 45 },
  pendingUserAutoDeleteLastRunAt: { type: Date, default: null },
  pendingUserAutoDeleteLastRunCount: { type: Number, default: 0 },
  pendingUserAutoDeleteLastRunBy: { type: String, default: "" },
  campaignApprovalMode: {
    type: String,
    enum: ["manual", "auto_live"],
    default: "manual",
  },
  collaborationApprovalMode: {
    type: String,
    enum: ["manual", "auto_live"],
    default: "manual",
  },
  platformFeeEnabled: { type: Boolean, default: false },
  platformFeePercent: { type: Number, default: 5 },
  platformCommissionPercent: { type: Number, default: 12 },
  inviteUnlockFee: { type: Number, default: 499 },
  minimumCampaignFee: { type: Number, default: 1000 },
  gstPercent: { type: Number, default: 0 },
  submissionApprovalWaitHours: { type: Number, default: 24 },
  payoutReleaseWaitHours: { type: Number, default: 24 },
  earlyAccessAssignmentMode: {
    type: String,
    enum: ["manual", "auto"],
    default: "manual",
  },
  earlyAccessLastRunAt: { type: Date, default: null },
  earlyAccessLastRunStatus: { type: String, default: "" },
  earlyAccessLastRunDetails: { type: String, default: "" },
  earlyAccessLastRunMode: { type: String, default: "" },
  feeActivationDate: { type: Date },
  // Support contact — admin-managed, surfaced as banner on campaign management page
  // and (post-Razorpay launch) kept as a "Need help?" channel for queries.
  supportContactEnabled: { type: Boolean, default: true },
  supportContactEmail: { type: String, default: "support@trendstarz.in" },
  supportContactPhone: { type: String, default: "" },
  supportContactWhatsapp: { type: String, default: "" },
  verificationCallNumber: { type: String, default: "" },
  supportContactMessage: {
    type: String,
    default:
      "For now, please contact our team to complete campaign payments. Our admin will update the payment status once received.",
  },
  // Campaign payment UPI address shown to brands on the payment screen
  paymentUpiId: { type: String, default: "trendstarzin@kotak" },
  // Navbar link visibility controls (admin-managed)
  showSearchLink: { type: Boolean, default: true },
  showRegisterInfluencerLink: { type: Boolean, default: true },
  showRegisterBrandLink: { type: Boolean, default: true },
  showRegisterPhotographerLink: { type: Boolean, default: true },
  campaignTypeConfigs: {
    type: [Schema.Types.Mixed],
    default: () => [],
  },
});
export const AppSettingsModel = model("AppSettings", AppSettingsSchema);

export const CategorySchema = new Schema({
  name: { type: String, required: true },
  role: {
    type: String,
    enum: ["influencer", "brand", "photographer", "both"],
    default: "both",
  },
  showInFrontend: { type: Boolean, default: true },
  sortIndex: { type: Number, default: 0 },
});
export const CategoryModel = model("Category", CategorySchema);

export const StateSchema = new Schema({
  name: { type: String, required: true },
  showInFrontend: { type: Boolean, default: true },
});
export const StateModel = model("State", StateSchema);

export const DistrictSchema = new Schema({
  name: { type: String, required: true },
  state: { type: String, required: true },
  showInFrontend: { type: Boolean, default: true },
});
DistrictSchema.index({ state: 1 });
export const DistrictModel = model("District", DistrictSchema);

export const SocialMediaSchema = new Schema({
  name: { type: String, required: true },
  showInFrontend: { type: Boolean, default: true },
  icon: { type: String },
  color: { type: String },
  handleLabel: { type: String, default: "Handle" },
  followersLabel: { type: String, default: "Followers" },
  contentTypes: [
    {
      name: { type: String, required: true },
      visible: { type: Boolean, default: true },
    },
  ],
});
export const SocialMediaModel = model("SocialMedia", SocialMediaSchema);

// Campaign schema
export const CampaignSchema = new Schema(
  {
    brandId: {
      type: Schema.Types.Mixed, // Allow ObjectId or string
      ref: "Brand",
      required: true,
      index: true,
    },
    title: { type: String, required: true },
    description: { type: String },
    campaignType: {
      type: String,
      enum: [
        // Brand-led campaign types
        "paid_collab",
        "product",
        "invite_location",
        "pay_to_join",
        // Photographer-led collaboration types
        "portfolio_collab",
        "reel_collab",
        "creative_project",
      ],
      default: "paid_collab",
      index: true,
    },
    // Logistics discriminator — derived from campaignType + ownerType + shoot/shipping flags.
    // Additive: existing consumers still use campaignType. New consumers can branch on this
    // to keep downstream logic (fulfilment, dashboards, analytics) decoupled from
    // creator-facing campaign labels.
    logisticsType: {
      type: String,
      enum: [
        "none",
        "ship_to_creator",
        "in_person_event",
        "on_location_shoot",
        "remote_delivery",
        "pay_to_join_program",
      ],
      default: "none",
      index: true,
    },
    campaignMode: {
      type: String,
      enum: ["invite_only", "tier_filtered_open"],
      default: "invite_only",
      index: true,
    },
    ownerType: {
      type: String,
      enum: ["brand", "photographer"],
      default: "brand",
      index: true,
    },
    inviteRecipientRole: {
      type: String,
      enum: ["influencer", "photographer"],
      default: "influencer",
      index: true,
    },
    /**
     * Multi-role invite slots (additive). Models campaigns that need more than
     * one creator role on the same shoot/event, e.g. "1 photographer + 2
     * influencers". When empty, the legacy single-role `inviteRecipientRole`
     * + `maxInfluencers` flow is used. Consumers MUST treat absence as the
     * legacy single-role mode for backwards-compatibility.
     */
    inviteSlots: [
      {
        role: {
          type: String,
          enum: ["influencer", "photographer"],
          required: true,
        },
        count: { type: Number, required: true, min: 1 },
        // Compensation override per slot (paise). Optional — falls back to
        // campaign-level `pricePerInfluencer` when not set.
        comp: { type: Number, default: null },
        // Free-text role notes (e.g. "fashion creator", "reel specialist").
        notes: { type: String, default: "" },
      },
    ],
    requestKind: {
      type: String,
      enum: [
        "brand_campaign",
        "creative_requirement",
        "photographer_collaboration",
      ],
      default: "brand_campaign",
      index: true,
    },
    image: {
      url: { type: String },
      public_id: { type: String },
    },
    status: {
      type: String,
      enum: [
        "draft",
        "pending",
        "pending_review",
        "needs_changes",
        "active",
        "rejected",
        "completed",
      ],
      default: "draft",
    },
    moderationNote: { type: String, default: "" },
    moderatedBy: { type: String, default: "" },
    moderatedAt: { type: Date, default: null },
    budgetMin: { type: Number },
    budgetMax: { type: Number },
    pricePerInfluencer: { type: Number }, // paise
    maxInfluencers: { type: Number },
    minInfluencers: { type: Number },
    acceptanceDeadline: { type: Date },
    estimatedBudget: { type: Number }, // paise
    timelineStart: { type: Date },
    timelineEnd: { type: Date },
    startDate: { type: Date },
    endDate: { type: Date },
    platforms: [{ type: String }],
    categories: [{ type: String }],
    deliverables: [{ type: String }],
    socialMedia: [
      {
        platform: { type: String },
        contentTypes: [
          {
            name: { type: String },
            enabled: { type: Boolean, default: false },
            price: { type: Number, default: 0 },
          },
        ],
      },
    ],
    minFollowerCount: { type: Number },
    maxFollowerCount: { type: Number },
    minInfluencerTier: { type: String },
    targetTiers: [{ type: String }],
    targetState: { type: String },
    targetDistrict: { type: String },
    targetCities: [{ type: String }],
    platformPreference: { type: String },
    specialInstructions: { type: String },
    // photographer collaboration location fields
    shootLocationType: { type: String },
    shootLocationAddress: { type: String },
    shootLocationMapUrl: { type: String },
    shootLocationNotes: { type: String },
    // invite_location specific fields
    venueName: { type: String },
    venueAddress: { type: String },
    venueCity: { type: String },
    venueDistrict: { type: String },
    venueState: { type: String },
    venueGoogleMapUrl: { type: String },
    productValue: { type: Number },
    productDescription: { type: String },
    productPaymentMode: { type: String },
    productPaymentAmount: { type: Number },
    productShippingRequired: { type: Boolean, default: false },
    inviteBenefits: { type: String },
    // pay_to_join specific fields
    payToJoinBenefits: { type: String },
    payToJoinInstructions: { type: String },
  },
  { timestamps: true },
);
CampaignSchema.index({ status: 1 });
export const CampaignModel = model("Campaign", CampaignSchema);

// Campaign Invite schema
export const CampaignInviteSchema = new Schema(
  {
    campaignId: {
      type: Schema.Types.Mixed, // Allow ObjectId or string for legacy compatibility
      ref: "Campaign",
      required: true,
      index: true,
    },
    brandId: {
      type: Schema.Types.Mixed, // Allow ObjectId or string for minimal brand profiles
      ref: "Brand",
      required: true,
      index: true,
    },
    influencerId: {
      type: Types.ObjectId,
      ref: "Influencer",
      required: true,
      index: true,
    },
    recipientRole: {
      type: String,
      enum: ["influencer", "photographer"],
      default: "influencer",
      index: true,
    },
    status: {
      type: String,
      enum: ["pending", "accepted", "declined", "submitted", "completed"],
      default: "pending",
    },
    selectedPlatform: { type: String, default: null }, // platform the influencer will post on
    // Shipping address captured from the creator at acceptance time for Product Collabs.
    // Required server-side when campaign.campaignType === 'product' && campaign.productShippingRequired === true.
    shippingAddress: {
      contactName: { type: String },
      contactMobile: { type: String },
      line1: { type: String },
      line2: { type: String },
      city: { type: String },
      state: { type: String },
      pincode: { type: String },
      landmark: { type: String },
      capturedAt: { type: Date },
    },
    analytics: {
      reach: { type: Number },
      engagement: { type: Number },
      clicks: { type: Number },
    },
  },
  { timestamps: true },
);
export const CampaignInviteModel = model(
  "CampaignInvite",
  CampaignInviteSchema,
);
