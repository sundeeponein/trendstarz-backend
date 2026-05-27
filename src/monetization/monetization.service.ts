import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Types } from "mongoose";
import * as crypto from "crypto";
import { RazorpayService } from "../payment/razorpay.service";
import { PlansService } from "../plans/plans.service";
import { CampaignInvitesService } from "../campaigns/campaign-invites.service";

type UserRole = "brand" | "influencer" | "photographer";

function toObjectId(value: string) {
  return new Types.ObjectId(value);
}

function toDayKey(date = new Date()): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

@Injectable()
export class MonetizationService {
  constructor(
    @InjectModel("AppSettings") private readonly appSettingsModel: Model<any>,
    @InjectModel("Payment") private readonly paymentModel: Model<any>,
    @InjectModel("CampaignInvite") private readonly inviteModel: Model<any>,
    @InjectModel("Campaign") private readonly campaignModel: Model<any>,
    @InjectModel("Transaction") private readonly transactionModel: Model<any>,
    @InjectModel("CollaborationUnlock") private readonly unlockModel: Model<any>,
    @InjectModel("UsageCounter") private readonly usageModel: Model<any>,
    @InjectModel("SocialProfileClick") private readonly socialClickModel: Model<any>,
    private readonly razorpayService: RazorpayService,
    private readonly plansService: PlansService,
    private readonly invitesService: CampaignInvitesService,
  ) {}

  async getFeeSettings() {
    const settings =
      (await this.appSettingsModel.findOne().lean()) ||
      (await this.appSettingsModel.create({}));

    return {
      success: true,
      feeSettings: {
        platformFeePercent: Number(settings?.platformFeePercent ?? 5),
        inviteUnlockFee: Number(settings?.inviteUnlockFee ?? 499),
        minimumCampaignFee: Number(settings?.minimumCampaignFee ?? 1000),
        gstPercent: Number(settings?.gstPercent ?? 18),
        platformCommissionPercent: Number(settings?.platformCommissionPercent ?? 12),
      },
    };
  }

  async updateFeeSettings(payload: any) {
    const patch: any = {};
    const allowed = [
      "platformFeePercent",
      "inviteUnlockFee",
      "minimumCampaignFee",
      "gstPercent",
      "platformCommissionPercent",
    ];

    for (const key of allowed) {
      if (payload?.[key] !== undefined) {
        patch[key] = Number(payload[key]);
      }
    }

    if (patch.minimumCampaignFee !== undefined && patch.minimumCampaignFee < 0) {
      throw new BadRequestException("minimumCampaignFee must be >= 0");
    }

    await this.appSettingsModel.updateOne({}, { $set: patch }, { upsert: true });
    return this.getFeeSettings();
  }

  async createSubscriptionOrder(input: {
    userId: string;
    userRole: UserRole;
    planId: string;
    billingCycle: "monthly" | "yearly";
  }) {
    const plan: any = await this.plansService.planModel.findById(input.planId).lean();
    if (!plan) throw new NotFoundException("Plan not found");

    const amount = Number(
      input.billingCycle === "yearly"
        ? plan?.price?.yearly ?? 0
        : plan?.price?.monthly ?? 0,
    );
    if (amount <= 0) throw new BadRequestException("Invalid plan amount");

    const amountPaise = Math.round(amount * 100);
    const order = await this.razorpayService.createOrder(amountPaise, {
      userId: input.userId,
      premiumDuration: input.billingCycle === "yearly" ? "1y" : "1m",
    });

    const payment = await this.paymentModel.create({
      userId: toObjectId(input.userId),
      userType: input.userRole === "brand" ? "Brand" : input.userRole === "photographer" ? "Photographer" : "Influencer",
      transactionId: `rzp_sub_${Date.now()}`,
      amount: amountPaise,
      premiumDuration: input.billingCycle === "yearly" ? "1y" : "1m",
      status: "pending",
      paymentMethod: "upi",
      purpose: "subscription",
      orderId: order.orderId,
      paymentStatus: "created",
      metadata: {
        planId: input.planId,
        billingCycle: input.billingCycle,
      },
    });

    await this.transactionModel.create({
      userId: toObjectId(input.userId),
      userRole: input.userRole,
      type: "subscription_payment",
      relatedId: String(payment._id),
      amount,
      paymentProvider: "razorpay",
      orderId: order.orderId,
      paymentStatus: "created",
      netAmount: amount,
      logs: [{ event: "order_created", payload: { planId: input.planId } }],
    });

    return {
      success: true,
      order,
      paymentId: payment._id,
    };
  }

  async createInviteUnlockOrder(input: {
    inviteId: string;
    payerId: string;
    payerRole: UserRole;
  }) {
    const invite: any = await this.inviteModel.findById(input.inviteId).lean();
    if (!invite) throw new NotFoundException("Invite not found");

    if (!["accepted", "payment_confirmed", "working", "submitted", "completed"].includes(String(invite.status || ""))) {
      throw new BadRequestException("Invite must be accepted before unlock payment.");
    }

    const campaign: any = await this.campaignModel.findById(invite.campaignId).lean();
    if (!campaign) throw new NotFoundException("Campaign not found");

    const settingsRes = await this.getFeeSettings();
    const feeSettings = settingsRes.feeSettings;
    const campaignType = String(campaign?.campaignType || "");
    if (campaignType === "invite_location") {
      throw new BadRequestException(
        "Invite to Location does not require unlock payment. Contact and venue details unlock after acceptance.",
      );
    }
    const isPaidCampaign = campaignType === "paid_collab";
    const amount = isPaidCampaign
      ? Math.max(Number(campaign?.pricePerInfluencer || 0), feeSettings.minimumCampaignFee)
      : feeSettings.inviteUnlockFee;

    const commissionPercent = feeSettings.platformCommissionPercent;
    const gstPercent = feeSettings.gstPercent;
    const commissionAmount = Number(((amount * commissionPercent) / 100).toFixed(2));
    const gstAmount = Number(((amount * gstPercent) / 100).toFixed(2));
    const grossAmount = Number((amount + commissionAmount + gstAmount).toFixed(2));

    const order = await this.razorpayService.createOrder(Math.round(grossAmount * 100), {
      userId: input.payerId,
      premiumDuration: "1m",
    });

    const payment = await this.paymentModel.create({
      userId: toObjectId(input.payerId),
      userType: input.payerRole === "brand" ? "Brand" : input.payerRole === "photographer" ? "Photographer" : "Influencer",
      transactionId: `rzp_unlock_${Date.now()}`,
      amount: Math.round(grossAmount * 100),
      premiumDuration: "1m",
      status: "pending",
      paymentMethod: "upi",
      purpose: "invite_unlock",
      orderId: order.orderId,
      paymentStatus: "created",
      metadata: {
        inviteId: input.inviteId,
        campaignId: String(invite.campaignId),
      },
      feeBreakdown: {
        baseAmount: amount,
        commissionPercent,
        commissionAmount,
        gstPercent,
        gstAmount,
        totalAmount: grossAmount,
      },
    });

    const tx = await this.transactionModel.create({
      userId: toObjectId(input.payerId),
      userRole: input.payerRole,
      type: "invite_unlock_payment",
      relatedId: String(input.inviteId),
      amount: grossAmount,
      commissionAmount,
      gstAmount,
      netAmount: amount,
      paymentProvider: "razorpay",
      orderId: order.orderId,
      paymentStatus: "created",
      metadata: {
        inviteId: input.inviteId,
        campaignId: String(invite.campaignId),
      },
      logs: [{ event: "order_created", payload: { inviteId: input.inviteId } }],
    });

    const recipientId = String(invite.influencerId);
    const recipientRole = String(invite.recipientRole || "influencer") as UserRole;
    await this.unlockModel.updateOne(
      { inviteId: toObjectId(input.inviteId), payerId: toObjectId(input.payerId) },
      {
        $set: {
          campaignId: toObjectId(String(invite.campaignId)),
          payerRole: input.payerRole,
          recipientId: toObjectId(recipientId),
          recipientRole,
          collaborationType: this.mapCampaignType(campaign?.campaignType),
          unlockKind: isPaidCampaign ? "paid_campaign_payment" : "coordination_unlock_fee",
          amount: grossAmount,
          platformCommissionPercent: commissionPercent,
          gstPercent,
          status: "pending",
          paymentStatus: "created",
          paymentId: payment._id,
          transactionId: tx._id,
        },
      },
      { upsert: true },
    );

    return {
      success: true,
      order,
      unlock: {
        inviteId: input.inviteId,
        amount: grossAmount,
        commissionAmount,
        gstAmount,
      },
    };
  }

  async verifyRazorpayPayment(input: {
    orderId: string;
    paymentId: string;
    signature: string;
    paymentType: "subscription" | "invite_unlock";
    userId: string;
  }) {
    const valid = this.razorpayService.verifySignature(
      input.orderId,
      input.paymentId,
      input.signature,
    );

    if (!valid) {
      throw new BadRequestException("Invalid payment signature");
    }

    const payment: any = await this.paymentModel.findOne({ orderId: input.orderId });
    if (!payment) throw new NotFoundException("Payment order not found");

    payment.paymentId = input.paymentId;
    payment.paymentStatus = "captured";
    payment.status = "approved";
    payment.gatewayVerifiedAt = new Date();
    payment.gatewaySignature = input.signature;
    payment.gatewayProvider = "razorpay";
    await payment.save();

    await this.transactionModel.updateMany(
      { orderId: input.orderId },
      {
        $set: { paymentId: input.paymentId, paymentStatus: "captured" },
        $push: {
          logs: {
            at: new Date(),
            event: "payment_captured",
            payload: { orderId: input.orderId },
          },
        },
      },
    );

    if (input.paymentType === "invite_unlock") {
      const inviteId = String(payment?.metadata?.inviteId || "").trim();
      if (inviteId) {
        await this.unlockModel.updateOne(
          { inviteId: toObjectId(inviteId) },
          {
            $set: {
              status: "paid",
              paymentStatus: "captured",
              unlockedAt: new Date(),
            },
          },
        );
        const payerRole = String(payment?.userType || "").toLowerCase();
        if (payerRole === "brand") {
          await this.invitesService.unlockContact(inviteId, input.userId);
        } else {
          await this.inviteModel.findByIdAndUpdate(inviteId, {
            $set: {
              unlocked: true,
              unlockedAt: new Date(),
              unlockType: "premium",
            },
          });
        }
      }
    }

    if (input.paymentType === "subscription") {
      const planId = String(payment?.metadata?.planId || "").trim();
      const billingCycle = String(payment?.metadata?.billingCycle || "monthly");
      const paymentUserType = String(payment?.userType || "Influencer");
      const normalizedUserType =
        paymentUserType === "Brand"
          ? "Brand"
          : paymentUserType === "Photographer"
            ? "Photographer"
            : "Influencer";
      if (planId) {
        await this.plansService.activateSubscription(
          input.userId,
          normalizedUserType,
          planId,
          billingCycle === "yearly" ? "1y" : "1m",
          "payment",
        );
      }
    }

    return { success: true, paymentId: input.paymentId };
  }

  async trackSocialClick(input: {
    actorUserId: string;
    actorRole: UserRole;
    targetUserId: string;
    targetRole: UserRole;
    platform: string;
    url: string;
    source?: string;
    userAgent?: string;
    ip?: string;
  }) {
    const ipHash = input.ip
      ? crypto.createHash("sha256").update(String(input.ip)).digest("hex")
      : "";

    const doc = await this.socialClickModel.create({
      actorUserId: toObjectId(input.actorUserId),
      actorRole: input.actorRole,
      targetUserId: toObjectId(input.targetUserId),
      targetRole: input.targetRole,
      platform: String(input.platform || "").toLowerCase(),
      url: input.url,
      source: input.source || "profile",
      day: toDayKey(),
      userAgent: input.userAgent || "",
      ipHash,
    });

    return { success: true, clickId: doc._id };
  }

  async getUsageSummary(userId: string, userRole: UserRole) {
    const day = toDayKey();
    const [search, profileView, caps] = await Promise.all<any>([
      this.usageModel.findOne({ userId, userRole, usageType: "search", day }).lean(),
      this.usageModel.findOne({ userId, userRole, usageType: "profile_view", day }).lean(),
      this.plansService.getUserPlanCapabilities(userId),
    ]);

    const searchLimit = Number(
      (caps?.limits || []).find((l: any) => l?.key === "dailySearchLimit")?.value || 0,
    );
    const profileLimit = Number(
      (caps?.limits || []).find((l: any) => l?.key === "dailyProfileViewLimit")?.value || 0,
    );

    return {
      success: true,
      usage: {
        day,
        search: {
          used: Number(search?.used || 0),
          limit: searchLimit,
          remaining: Math.max(searchLimit - Number(search?.used || 0), 0),
        },
        profileViews: {
          used: Number(profileView?.used || 0),
          limit: profileLimit,
          remaining: Math.max(profileLimit - Number(profileView?.used || 0), 0),
        },
      },
    };
  }

  async adminRevenueSummary(days = 30) {
    const since = new Date(Date.now() - Math.max(days, 1) * 24 * 60 * 60 * 1000);

    const [totals, byType, premiumUsers, activeUnlocks] = await Promise.all([
      this.transactionModel.aggregate([
        { $match: { createdAt: { $gte: since }, paymentStatus: "captured" } },
        {
          $group: {
            _id: null,
            revenue: { $sum: "$amount" },
            commission: { $sum: "$commissionAmount" },
            gst: { $sum: "$gstAmount" },
          },
        },
      ]),
      this.transactionModel.aggregate([
        { $match: { createdAt: { $gte: since }, paymentStatus: "captured" } },
        { $group: { _id: "$type", amount: { $sum: "$amount" }, count: { $sum: 1 } } },
      ]),
      this.plansService.subscriptionModel.countDocuments({ status: "active" }),
      this.unlockModel.countDocuments({ status: "paid" }),
    ]);

    return {
      success: true,
      summary: {
        from: since,
        to: new Date(),
        totalRevenue: Number(totals?.[0]?.revenue || 0),
        totalCommission: Number(totals?.[0]?.commission || 0),
        totalGst: Number(totals?.[0]?.gst || 0),
        premiumUsers,
        activeUnlocks,
        revenueByType: byType,
      },
    };
  }

  private mapCampaignType(type: string):
    | "paid_campaign"
    | "product_collaboration"
    | "event_invite"
    | "reels_ugc_collaboration"
    | "photoshoot_collaboration" {
    const normalized = String(type || "").toLowerCase();
    if (normalized === "paid_collab") return "paid_campaign";
    if (normalized === "product") return "product_collaboration";
    if (normalized === "invite_location") return "event_invite";
    if (normalized === "reels_ugc") return "reels_ugc_collaboration";
    return "photoshoot_collaboration";
  }
}
