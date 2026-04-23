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
  ) {}

  private normalizeUserType(userType?: string): "INFLUENCER" | "BRAND" {
    return userType?.toUpperCase() === "BRAND" ? "BRAND" : "INFLUENCER";
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

    return {
      ...dto,
      code,
      userType,
      price: {
        monthly: dto?.price?.monthly ?? existing?.price?.monthly ?? 0,
        quarterly: dto?.price?.quarterly ?? existing?.price?.quarterly ?? 0,
        yearly: dto?.price?.yearly ?? existing?.price?.yearly ?? 0,
      },
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
    };
  }

  private async resolveUserTypeById(
    userId: string,
  ): Promise<"INFLUENCER" | "BRAND"> {
    const objectId = new Types.ObjectId(userId);
    const influencer = await this.influencerModel.exists({ _id: objectId });
    if (influencer) return "INFLUENCER";
    const brand = await this.brandModel.exists({ _id: objectId });
    if (brand) return "BRAND";
    return "INFLUENCER";
  }

  // ── Admin: CRUD Plans ────────────────────────────────────────────────────

  async listAll() {
    const plans = await this.planModel
      .find()
      .sort({ sortOrder: 1, createdAt: 1 })
      .lean();
    return {
      success: true,
      plans: plans.map((plan: any) => this.normalizePlanDocument(plan)),
    };
  }

  async getById(id: string) {
    const plan = await this.planModel.findById(id).lean();
    if (!plan) throw new NotFoundException("Plan not found");
    return { success: true, plan: this.normalizePlanDocument(plan) };
  }

  async create(dto: any) {
    const normalized = this.normalizePlanDto(dto);
    const plan = await this.planModel.create({
      ...normalized,
    });
    return { success: true, plan: this.normalizePlanDocument(plan.toObject()) };
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
    return { success: true, plan: this.normalizePlanDocument(plan) };
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
      plans: plans.map((plan: any) => this.normalizePlanDocument(plan)),
    };
  }

  // ── Subscription management ──────────────────────────────────────────────

  /** Activate/renew a subscription for userId after payment approval */
  async activateSubscription(
    userId: string,
    userType: "Influencer" | "Brand",
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
      const defaults = FREE_PLAN_DEFAULTS[userType] as any;
      return {
        hasPremium: false,
        planName: "Free",
        features: defaults.features,
        limits: defaults.limits,
        policies: defaults.policies,
        endDate: null,
      };
    }
    return {
      hasPremium: true,
      planName: sub.planName,
      features: sub.featuresSnapshot,
      limits: sub.limitsSnapshot,
      policies: sub.policiesSnapshot,
      endDate: sub.endDate,
    };
  }

  /** Check a boolean feature for a user */
  async checkFeature(userId: string, featureKey: string): Promise<boolean> {
    const caps = await this.getUserPlanCapabilities(userId);
    const feature = caps.features.find((f: any) => f.key === featureKey);
    return feature ? feature.value === true : false;
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
  async getSubscriptionsForImageCleanup(retentionDays: number) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - retentionDays);
    return this.subscriptionModel
      .find({
        status: "expired",
        endDate: { $lte: cutoff },
        imagesMarkedForDeletionAt: null,
      })
      .lean();
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

  /** Get the first active Pro plan for the matching userType (used by payment approval) */
  async findProPlanForUserType(userType: "Influencer" | "Brand") {
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
}
