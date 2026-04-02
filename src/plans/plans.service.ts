/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return */
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
    @InjectModel("Plan") private readonly planModel: Model<any>,
    @InjectModel("Subscription") private readonly subscriptionModel: Model<any>,
    @InjectModel("Influencer") private readonly influencerModel: Model<any>,
    @InjectModel("Brand") private readonly brandModel: Model<any>,
  ) {}

  // ── Admin: CRUD Plans ────────────────────────────────────────────────────

  async listAll() {
    const plans = await this.planModel
      .find()
      .sort({ sortOrder: 1, createdAt: 1 })
      .lean();
    return { success: true, plans };
  }

  async getById(id: string) {
    const plan = await this.planModel.findById(id).lean();
    if (!plan) throw new NotFoundException("Plan not found");
    return { success: true, plan };
  }

  async create(dto: any) {
    const plan = await this.planModel.create(dto);
    return { success: true, plan };
  }

  async update(id: string, dto: any) {
    const plan = await this.planModel
      .findByIdAndUpdate(id, dto, { new: true })
      .lean();
    if (!plan) throw new NotFoundException("Plan not found");
    return { success: true, plan };
  }

  async remove(id: string) {
    await this.planModel.findByIdAndDelete(id);
    return { success: true };
  }

  // ── Public: Plans for user type ──────────────────────────────────────────

  async listActive(userType?: string) {
    const query: any = { isActive: true };
    if (userType) query.$or = [{ userType }, { userType: "ALL" }];
    const plans = await this.planModel
      .find(query)
      .sort({ sortOrder: 1 })
      .lean();
    return { success: true, plans };
  }

  // ── Subscription management ──────────────────────────────────────────────

  /** Activate/renew a subscription for userId after payment approval */
  async activateSubscription(
    userId: string,
    userType: "Influencer" | "Brand",
    planId: string,
    duration: "1m" | "3m" | "1y",
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

    const subscription = await this.subscriptionModel.create({
      userId: new Types.ObjectId(userId),
      userType,
      planId: plan._id,
      planName: plan.name,
      featuresSnapshot: plan.features,
      limitsSnapshot: plan.limits,
      policiesSnapshot: plan.policies,
      startDate: now,
      endDate: end,
      duration,
      status: "active",
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
      return {
        hasPremium: false,
        planName: "Free",
        features: FREE_PLAN_DEFAULTS.features,
        limits: FREE_PLAN_DEFAULTS.limits,
        policies: FREE_PLAN_DEFAULTS.policies,
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

  // ── Seeding default plans ─────────────────────────────────────────────────

  async seedDefaultPlans() {
    const count = await this.planModel.countDocuments();
    if (count > 0) return { seeded: false, message: "Plans already exist" };

    const defaultPlans = [
      {
        name: "Pro",
        userType: "INFLUENCER",
        price: { monthly: 399, yearly: 2999 },
        features: [
          {
            key: "socialMediaVisibility",
            label: "Show Social Media Links",
            value: true,
          },
          {
            key: "contactVisibility",
            label: "Show Contact Details",
            value: true,
          },
          {
            key: "priorityListing",
            label: "Priority Listing in Search",
            value: true,
          },
        ],
        limits: [
          { key: "maxImages", label: "Max Images Upload", value: 20 },
          { key: "maxCampaigns", label: "Max Campaigns", value: 10 },
        ],
        policies: { imageRetentionDaysAfterExpiry: 45 },
        highlight: true,
        isActive: true,
        sortOrder: 1,
      },
      {
        name: "Pro",
        userType: "BRAND",
        price: { monthly: 399, yearly: 2999 },
        features: [
          {
            key: "socialMediaVisibility",
            label: "Show Social Media Links",
            value: true,
          },
          {
            key: "contactVisibility",
            label: "Show Contact Details",
            value: true,
          },
          {
            key: "priorityListing",
            label: "Priority Listing in Search",
            value: true,
          },
        ],
        limits: [
          { key: "maxImages", label: "Max Product Images", value: 10 },
          { key: "maxCampaigns", label: "Max Campaigns", value: 10 },
        ],
        policies: { imageRetentionDaysAfterExpiry: 45 },
        highlight: true,
        isActive: true,
        sortOrder: 1,
      },
    ];

    await this.planModel.insertMany(defaultPlans);
    return { seeded: true, message: "Default plans created" };
  }

  /** Get the first active Pro plan for the matching userType (used by payment approval) */
  async findProPlanForUserType(userType: "Influencer" | "Brand") {
    const mapped = userType === "Influencer" ? "INFLUENCER" : "BRAND";
    const plan = (await this.planModel
      .findOne({
        isActive: true,
        $or: [{ userType: mapped }, { userType: "ALL" }],
      })
      .sort({ sortOrder: 1 })
      .lean()) as any;
    if (!plan)
      throw new BadRequestException("No active plan found for user type");
    return plan;
  }
}
