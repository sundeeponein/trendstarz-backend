import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Types } from "mongoose";
import { FREE_PLAN_DEFAULTS } from "../database/schemas/plan.schema";

@Injectable()
export class PlansService {
  constructor(
    @InjectModel("Plan") public readonly planModel: Model<any>,
    @InjectModel("Subscription") public readonly subscriptionModel: Model<any>,
    @InjectModel("Influencer") private readonly influencerModel: Model<any>,
    @InjectModel("Brand") private readonly brandModel: Model<any>,
    @InjectModel("Photographer") private readonly photographerModel: Model<any>,
  ) {}

  private normalizeUserType(
    userType?: string,
  ): "INFLUENCER" | "BRAND" | "PHOTOGRAPHER" {
    const normalized = String(userType || "").toUpperCase();
    if (normalized === "BRAND") return "BRAND";
    if (normalized === "PHOTOGRAPHER") return "PHOTOGRAPHER";
    return "INFLUENCER";
  }

  private durationToBillingCycle(
    duration: "1m" | "3m" | "1y",
  ): "monthly" | "quarterly" | "yearly" {
    if (duration === "3m") return "quarterly";
    if (duration === "1y") return "yearly";
    return "monthly";
  }

  private buildPlanCode(name: string, userType: string): string {
    const typePrefix = this.normalizeUserType(userType).toLowerCase();
    const slug = name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "");
    return `${typePrefix}-${slug || "plan"}`;
  }

  private normalizePlanDto(dto: any, existing?: any) {
    const userType = this.normalizeUserType(
      dto?.userType ?? existing?.userType,
    );
    const name = dto?.name ?? existing?.name ?? "Plan";
    const code =
      dto?.code ?? existing?.code ?? this.buildPlanCode(name, userType);
    const policies = dto?.policies ?? existing?.policies;
    const features = dto?.features ?? existing?.features ?? [];

    return {
      ...dto,
      code,
      userType,
      discountLabel:
        dto?.discountLabel ?? existing?.discountLabel ?? "",
      founderOfferName:
        dto?.founderOfferName ?? existing?.founderOfferName ?? "Founder Launch Offer",
      founderOfferWindowDays:
        dto?.founderOfferWindowDays ?? existing?.founderOfferWindowDays ?? 7,
      founderOfferForNewUsers:
        dto?.founderOfferForNewUsers ?? existing?.founderOfferForNewUsers ?? true,
      founderOfferForExistingUsers:
        dto?.founderOfferForExistingUsers ?? existing?.founderOfferForExistingUsers ?? true,
      founderOfferAudienceCap:
        dto?.founderOfferAudienceCap ?? existing?.founderOfferAudienceCap ?? 0,
      founderOfferEndsAt:
        dto?.founderOfferEndsAt ?? existing?.founderOfferEndsAt ?? null,
      price: {
        monthly: dto?.price?.monthly ?? existing?.price?.monthly ?? 0,
        quarterly: dto?.price?.quarterly ?? existing?.price?.quarterly ?? 0,
        yearly: dto?.price?.yearly ?? existing?.price?.yearly ?? 0,
      },
      features,
      policies,
      offers: dto?.offers ?? existing?.offers ?? [],
    };
  }

  private normalizePlanDocument(plan: any) {
    if (!plan) return plan;

    return {
      ...plan,
      price: {
        monthly: plan?.price?.monthly ?? 0,
        quarterly: plan?.price?.quarterly ?? 0,
        yearly: plan?.price?.yearly ?? 0,
      },
      features: Array.isArray(plan?.features) ? plan.features : [],
      founderOfferAudienceCap: Number(plan?.founderOfferAudienceCap || 0),
      founderOfferEndsAt: plan?.founderOfferEndsAt ?? null,
    };
  }

  private async withFounderOfferAudienceStats(plan: any) {
    const normalized = this.normalizePlanDocument(plan);
    if (!normalized?.userType) return normalized;
    const count = await this.modelForUserType(normalized.userType).countDocuments({});
    return {
      ...normalized,
      founderOfferAudienceCount: count,
    };
  }

  private async resolveUserTypeById(
    userId: string,
  ): Promise<"INFLUENCER" | "BRAND" | "PHOTOGRAPHER"> {
    const objectId = new Types.ObjectId(userId);
    const influencer = await this.influencerModel.exists({ _id: objectId });
    if (influencer) return "INFLUENCER";
    const brand = await this.brandModel.exists({ _id: objectId });
    if (brand) return "BRAND";
    const photographer = await this.photographerModel.exists({ _id: objectId });
    if (photographer) return "PHOTOGRAPHER";
    return "INFLUENCER";
  }

  private modelForUserType(
    userType: "INFLUENCER" | "BRAND" | "PHOTOGRAPHER",
  ): Model<any> {
    if (userType === "BRAND") return this.brandModel;
    if (userType === "PHOTOGRAPHER") return this.photographerModel;
    return this.influencerModel;
  }

  /**
   * Re-derives Founder Offer eligibility at payment-approval time, mirroring
   * the frontend's isNewUserForFounderOffer/matchesFounderOfferAudience logic
   * (founder-offer.util.ts) so the bonus actually granted always matches what
   * the popup promised at the moment of approval — not at checkout time, since
   * admin approval can lag behind checkout by days.
   */
  private async isEligibleForFounderOffer(
    userId: string,
    userType: "INFLUENCER" | "BRAND" | "PHOTOGRAPHER",
    plan: any,
  ): Promise<boolean> {
    const model = this.modelForUserType(userType);
    const user = await model
      .findById(userId)
      .select("firstRegisteredAt createdAt")
      .lean();
    const registeredAt = (user as any)?.firstRegisteredAt || (user as any)?.createdAt;
    const windowDays = Number(plan?.founderOfferWindowDays ?? 7);
    const endsAt = plan?.founderOfferEndsAt ? new Date(plan.founderOfferEndsAt) : null;
    if (endsAt && Number.isFinite(endsAt.getTime()) && endsAt < new Date()) {
      return false;
    }
    const audienceCap = Number(plan?.founderOfferAudienceCap || 0);
    if (audienceCap > 0) {
      const audienceCount = await model.countDocuments({});
      if (audienceCount >= audienceCap) return false;
    }
    let isNew = true;
    if (registeredAt) {
      const elapsedDays =
        (Date.now() - new Date(registeredAt).getTime()) / (1000 * 60 * 60 * 24);
      isNew = elapsedDays <= windowDays;
    }
    return isNew
      ? (plan?.founderOfferForNewUsers ?? true)
      : (plan?.founderOfferForExistingUsers ?? true);
  }

  // ── Admin: CRUD Plans ────────────────────────────────────────────────────

  async listAll() {
    const plans = await this.planModel
      .find()
      .sort({ sortOrder: 1, createdAt: 1 })
      .lean();
    return {
      success: true,
      plans: await Promise.all(plans.map((plan: any) => this.withFounderOfferAudienceStats(plan))),
    };
  }

  async getById(id: string) {
    const plan = await this.planModel.findById(id).lean();
    if (!plan) throw new NotFoundException("Plan not found");
    return { success: true, plan: await this.withFounderOfferAudienceStats(plan) };
  }

  async create(dto: any) {
    const normalized = this.normalizePlanDto(dto);
    const plan = await this.planModel.create({
      ...normalized,
    });
    return { success: true, plan: await this.withFounderOfferAudienceStats(plan.toObject()) };
  }

  async replaceAllFromConfig(configPlans: any[]) {
    const normalizedPlans = configPlans.map((plan: any, index: number) =>
      this.normalizePlanDto({
        ...plan,
        sortOrder: plan?.sortOrder ?? index,
      }),
    );

    await this.planModel.deleteMany({});
    const insertedPlans = await this.planModel.insertMany(normalizedPlans);

    return insertedPlans.map((plan: any) =>
      this.normalizePlanDocument(plan.toObject()),
    );
  }

  async update(id: string, dto: any) {
    const existing = (await this.planModel.findById(id).lean()) as any;
    if (!existing) throw new NotFoundException("Plan not found");
    const normalized = this.normalizePlanDto(dto, existing);
    const plan = await this.planModel
      .findByIdAndUpdate(
        id,
        {
          $set: {
            name: normalized.name,
            code: normalized.code,
            userType: normalized.userType,
            price: normalized.price,
            features: normalized.features ?? existing.features,
            limits: normalized.limits ?? existing.limits,
            offers: normalized.offers ?? existing.offers ?? [],
            discountLabel: normalized.discountLabel ?? existing.discountLabel ?? "",
            founderOfferName: normalized.founderOfferName ?? existing.founderOfferName ?? "Founder Launch Offer",
            founderOfferWindowDays: normalized.founderOfferWindowDays ?? existing.founderOfferWindowDays ?? 7,
            founderOfferForNewUsers: normalized.founderOfferForNewUsers ?? existing.founderOfferForNewUsers ?? true,
            founderOfferForExistingUsers: normalized.founderOfferForExistingUsers ?? existing.founderOfferForExistingUsers ?? true,
            founderOfferAudienceCap: normalized.founderOfferAudienceCap ?? existing.founderOfferAudienceCap ?? 0,
            founderOfferEndsAt: normalized.founderOfferEndsAt ?? existing.founderOfferEndsAt ?? null,
            policies: normalized.policies ?? existing.policies,
            highlight: normalized.highlight ?? existing.highlight,
            isActive: normalized.isActive ?? existing.isActive,
            sortOrder: normalized.sortOrder ?? existing.sortOrder,
          },
        },
        { new: true },
      )
      .lean();
    if (!plan) throw new NotFoundException("Plan not found");
    return { success: true, plan: await this.withFounderOfferAudienceStats(plan) };
  }

  async remove(id: string) {
    await this.planModel.findByIdAndDelete(id);
    return { success: true };
  }

  // ── Public: Plans for user type ──────────────────────────────────────────

  async listActive(userType?: string) {
    const query: any = { isActive: true };
    if (userType) {
      query.userType = this.normalizeUserType(userType);
    }
    const plans = await this.planModel
      .find(query)
      .sort({ sortOrder: 1 })
      .lean();
    return {
      success: true,
      plans: await Promise.all(plans.map((plan: any) => this.withFounderOfferAudienceStats(plan))),
    };
  }

  // ── Subscription management ──────────────────────────────────────────────

  /** Activate/renew a subscription for userId after payment approval */
  async activateSubscription(
    userId: string,
    userType: "Influencer" | "Brand" | "Photographer",
    planId: string,
    duration: "1m" | "3m" | "1y",
    source: "admin" | "payment" = "payment",
  ) {
    const plan = (await this.planModel.findById(planId).lean()) as any;
    if (!plan) {
      // fallback: resolve a plan by name/duration mapping
      throw new NotFoundException("Plan not found");
    }
    // Expire any existing active subscription
    await this.subscriptionModel.updateMany(
      { userId: new Types.ObjectId(userId), status: "active" },
      { status: "expired" },
    );

    const now = new Date();
    const end = new Date(now);
    if (duration === "1m") end.setMonth(end.getMonth() + 1);
    else if (duration === "3m") end.setMonth(end.getMonth() + 3);
    else if (duration === "1y") end.setFullYear(end.getFullYear() + 1);
    const billingCycle = this.durationToBillingCycle(duration);

    // Admin-configurable bonus duration (e.g. "pay 1 month, get 2" promos),
    // set per-cycle in Admin → Plans → Pricing & Discounts. Same mechanism as
    // the existing discount offers — no separate fee/plan type needed. This
    // "standing" bonus applies to every purchase of this cycle, regardless of
    // Founder Offer eligibility.
    const cycleSuffix =
      billingCycle === "monthly"
        ? "Monthly"
        : billingCycle === "quarterly"
          ? "Quarterly"
          : "Yearly";
    const bonusMonths = Number(
      (plan.offers || []).find((o: any) => o.key === `bonusMonths${cycleSuffix}`)
        ?.value || 0,
    );
    if (bonusMonths > 0) end.setMonth(end.getMonth() + bonusMonths);

    // Founder Offer bonus stacks on top of the standing bonus above, but only
    // when the user is still eligible at approval time (Admin → Plans →
    // First-Login Founder Offer Popup → audience checkboxes + window days).
    const founderBonusMonths = Number(
      (plan.offers || []).find(
        (o: any) => o.key === `founderBonusMonths${cycleSuffix}`,
      )?.value || 0,
    );
    if (founderBonusMonths > 0) {
      const eligible = await this.isEligibleForFounderOffer(
        userId,
        this.normalizeUserType(userType),
        plan,
      );
      if (eligible) end.setMonth(end.getMonth() + founderBonusMonths);
    }

    const subscription = await this.subscriptionModel.create({
      userId: new Types.ObjectId(userId),
      userType: this.normalizeUserType(userType),
      planId: plan._id,
      planCode: plan.code ?? this.buildPlanCode(plan.name, plan.userType),
      planName: plan.name,
      billingCycle,
      priceSnapshot: plan.price?.[billingCycle] ?? 0,
      featuresSnapshot: plan.features,
      limitsSnapshot: plan.limits,
      policiesSnapshot: plan.policies,
      startDate: now,
      endDate: end,
      status: "active",
      source,
    });

    return subscription;
  }

  /** Get active subscription for a user (returns null if none) */
  async getActiveSubscription(userId: string) {
    const now = new Date();
    const sub = (await this.subscriptionModel
      .findOne({
        userId: new Types.ObjectId(userId),
        status: "active",
        endDate: { $gte: now },
      })
      .lean()) as any;
    return sub ?? null;
  }

  /** Get full plan capabilities for a user (active sub or free defaults) */
  async getUserPlanCapabilities(userId: string) {
    const sub = await this.getActiveSubscription(userId);
    if (!sub) {
      const userType = await this.resolveUserTypeById(userId);
      const freePlan = await this.findFreePlanForUserType(
        userType === "BRAND"
          ? "Brand"
          : userType === "PHOTOGRAPHER"
            ? "Photographer"
            : "Influencer",
      );
      const userModel =
        userType === "BRAND"
          ? this.brandModel
          : userType === "PHOTOGRAPHER"
            ? this.photographerModel
            : this.influencerModel;
      let legacyUser: any = null;
      if (typeof (userModel as any)?.findById === "function") {
        legacyUser = (await userModel
          .findById(userId)
          .select("isPremium premiumEnd")
          .lean()) as any;
      }

      // Backward-compat: if premium was granted but subscription row is missing,
      // use active Pro plan snapshots so capabilities stay in sync with UI state.
      const hasLegacyPremium =
        !!legacyUser?.isPremium &&
        (!legacyUser?.premiumEnd || new Date(legacyUser.premiumEnd) >= new Date());
      if (hasLegacyPremium) {
        const proPlan = await this.findProPlanForUserType(
          userType === "BRAND"
            ? "Brand"
            : userType === "PHOTOGRAPHER"
              ? "Photographer"
              : "Influencer",
        );
        return {
          hasPremium: true,
          planName: proPlan.name,
          features: proPlan.features ?? [],
          limits: proPlan.limits ?? [],
          policies: proPlan.policies ?? { imageRetentionDaysAfterExpiry: 45 },
          endDate: legacyUser?.premiumEnd ?? null,
        };
      }

      const defaults = freePlan
        ? {
            features: freePlan.features ?? [],
            limits: freePlan.limits ?? [],
            policies:
              freePlan.policies ?? { imageRetentionDaysAfterExpiry: 45 },
          }
        : (FREE_PLAN_DEFAULTS[userType] as any);
      return {
        hasPremium: false,
        planName: freePlan?.name || "Free",
        features: defaults.features,
        limits: defaults.limits,
        policies: defaults.policies,
        endDate: null,
      };
    }
    return {
      hasPremium: true,
      planName: sub.planName,
      features: Array.isArray(sub.featuresSnapshot)
        ? sub.featuresSnapshot
        : [],
      limits: Array.isArray(sub.limitsSnapshot) ? sub.limitsSnapshot : [],
      policies: sub.policiesSnapshot ?? { imageRetentionDaysAfterExpiry: 45 },
      endDate: sub.endDate,
    };
  }

  /** Check a boolean feature for a user */
  async checkFeature(userId: string, featureKey: string): Promise<boolean> {
    const caps = await this.getUserPlanCapabilities(userId);
    const feature = caps.features.find((f: any) => f.key === featureKey);
    return feature ? feature.value === true : false;
  }

  /**
   * Reusable, role-agnostic gate for whether a viewer may open another profile's
   * social media links/handles. Guests (no viewerId) are always denied; logged-in
   * viewers are gated on their own plan's socialMediaVisibility/viewSocialLinks
   * feature (Free plans typically have it off, Premium/Pro plans on). Used by
   * Influencer, Brand, and Photographer public-profile lookups alike so the
   * Guest/Free/Premium rule stays in one place instead of being copied per role.
   */
  async canViewSocialLinks(viewerId?: string | null): Promise<boolean> {
    if (!viewerId) return false;
    const caps = await this.getUserPlanCapabilities(String(viewerId));
    return (caps?.features || []).some((f: any) => {
      const key = String(f?.key || "");
      const enabled = !!f?.value;
      return (
        enabled &&
        (key === "socialMediaVisibility" || key === "viewSocialLinks")
      );
    });
  }

  /** Get a numeric limit for a user */
  async getLimit(userId: string, limitKey: string): Promise<number> {
    const caps = await this.getUserPlanCapabilities(userId);
    const limit = caps.limits.find((l: any) => l.key === limitKey);
    return limit ? limit.value : 0;
  }

  /** Expire subscriptions whose endDate has passed */
  async expireStaleSubscriptions() {
    const now = new Date();
    const result = await this.subscriptionModel.updateMany(
      { status: "active", endDate: { $lt: now } },
      { status: "expired" },
    );
    return result.modifiedCount;
  }

  /** Find expired subscriptions for image cleanup */
  async getSubscriptionsForImageCleanup(retentionDays?: number) {
    const query: any = {
      status: "expired",
      imagesMarkedForDeletionAt: null,
    };

    if (
      typeof retentionDays === "number" &&
      Number.isFinite(retentionDays) &&
      retentionDays > 0
    ) {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - retentionDays);
      query.endDate = { $lte: cutoff };
    }

    return this.subscriptionModel.find(query).lean();
  }

  async markImagesDeleted(subscriptionId: string) {
    await this.subscriptionModel.findByIdAndUpdate(subscriptionId, {
      imagesMarkedForDeletionAt: new Date(),
    });
  }

  /** Historical subscriptions for a user */
  async getUserSubscriptions(userId: string) {
    const subs = await this.subscriptionModel
      .find({ userId: new Types.ObjectId(userId) })
      .sort({ createdAt: -1 })
      .lean();
    return { success: true, subscriptions: subs };
  }

  /** Cancel any currently active subscription rows for a user (used by admin Set Free). */
  async cancelActiveSubscriptionsForUser(userId: string) {
    return this.subscriptionModel.updateMany(
      { userId: new Types.ObjectId(userId), status: "active" },
      { status: "cancelled" },
    );
  }

  /** Get the first active Pro plan for the matching userType (used by payment approval) */
  async findProPlanForUserType(
    userType: "Influencer" | "Brand" | "Photographer",
  ) {
    const mapped = this.normalizeUserType(userType);
    // Prefer the plan with the highest sortOrder that has a non-zero price (i.e. the Pro plan)
    let plan = (await this.planModel
      .findOne({
        isActive: true,
        userType: mapped,
        "price.monthly": { $gt: 0 },
      })
      .sort({ sortOrder: -1 })
      .lean()) as any;
    // Fallback: any active plan for the type (e.g. if all plans are free)
    if (!plan) {
      plan = (await this.planModel
        .findOne({ isActive: true, userType: mapped })
        .sort({ sortOrder: -1 })
        .lean()) as any;
    }
    if (!plan)
      throw new BadRequestException("No active plan found for user type");
    return plan;
  }

  /** Find the free plan for user type from DB (admin-managed), fallback to null. */
  async findFreePlanForUserType(
    userType: "Influencer" | "Brand" | "Photographer",
  ) {
    const mapped = this.normalizeUserType(userType);
    let plan = (await this.planModel
      .findOne({ isActive: true, userType: mapped, code: `${mapped.toLowerCase()}-free` })
      .sort({ sortOrder: 1 })
      .lean()) as any;

    if (!plan) {
      plan = (await this.planModel
        .findOne({
          isActive: true,
          userType: mapped,
          "price.monthly": 0,
          "price.quarterly": 0,
          "price.yearly": 0,
        })
        .sort({ sortOrder: 1 })
        .lean()) as any;
    }
    return plan || null;
  }
}
