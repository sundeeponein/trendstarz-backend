import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import { sendAppEmail } from "../utils/app-email.service";
import {
  paymentProofAdminTemplate,
  paymentVerifiedInfluencerTemplate,
  paymentVerifiedBrandTemplate,
  paymentRejectedTemplate,
  payoutSentTemplate,
} from "../email/templates/payment.templates";
import { PushService } from "../push/push.service";
import { NotificationsService } from "../notifications/notifications.service";

type FeeSettings = {
  platformFeeEnabled: boolean;
  platformFeePercent: number;
};

@Injectable()
export class PaymentsPayoutsService {
  constructor(
    @InjectModel("Campaign") private readonly campaignModel: Model<any>,
    @InjectModel("CampaignInvite") private readonly inviteModel: Model<any>,
    @InjectModel("CampaignTransaction")
    private readonly transactionModel: Model<any>,
    @InjectModel("AppSettings") private readonly appSettingsModel: Model<any>,
    @InjectModel("Brand") private readonly brandModel: Model<any>,
    @InjectModel("Influencer") private readonly influencerModel: Model<any>,
    @InjectModel("Photographer") private readonly photographerModel: Model<any>,
    private readonly pushService: PushService,
    private readonly notificationsService: NotificationsService,
  ) {}

  private roundPercent(amount: number, percent: number): number {
    return Math.round((amount * percent) / 100);
  }

  private splitEvenly(total: number, parts: number): number[] {
    if (parts <= 0) return [];
    const base = Math.floor(total / parts);
    const remainder = total % parts;
    return Array.from(
      { length: parts },
      (_, i) => base + (i < remainder ? 1 : 0),
    );
  }

  private async getFeeSettings(): Promise<FeeSettings> {
    const settings: any = await this.appSettingsModel.findOne({}).lean();
    return {
      platformFeeEnabled: !!settings?.platformFeeEnabled,
      platformFeePercent:
        typeof settings?.platformFeePercent === "number"
          ? settings.platformFeePercent
          : 10,
    };
  }

  /**
   * Calculate effective commission percentage for a user (brand or influencer)
   * Checks for commission override and applies discount/waiver/fixed rate
   */
  private async getEffectiveCommissionPercent(
    userId: string,
    userType: "brand" | "influencer",
    globalPercent: number,
  ): Promise<number> {
    try {
      const model =
        userType === "brand" ? this.brandModel : this.influencerModel;
      const user: any = await model.findById(userId).lean();

      if (!user || !user.commissionOverride?.enabled) {
        return globalPercent;
      }

      const override = user.commissionOverride;
      const now = new Date();

      // Check if override is within validity period
      if (
        (override.validFrom && new Date(override.validFrom) > now) ||
        (override.validUntil && new Date(override.validUntil) < now)
      ) {
        return globalPercent;
      }

      // Apply override based on type
      switch (override.overrideType) {
        case "waiver":
          return 0; // No commission
        case "discount":
          // discount is a percentage (e.g., 40% off means 40% reduction)
          return Math.max(
            0,
            globalPercent - (globalPercent * override.value) / 100,
          );
        case "fixed":
          // fixed is the actual commission percentage to apply
          return Math.max(0, override.value);
        default:
          return globalPercent;
      }
    } catch (error) {
      console.error("Error calculating effective commission:", error);
      return globalPercent;
    }
  }

  private async assertCampaignOwner(campaign: any, brandId: string) {
    if (String(campaign.brandId) === brandId) return;
    const brand = await this.brandModel
      .findById(brandId)
      .select("brandUsername")
      .lean();
    const brandUsername =
      brand && typeof brand === "object" && "brandUsername" in brand
        ? (brand as any).brandUsername
        : undefined;
    if (!brandUsername || String(campaign.brandId) !== brandUsername) {
      throw new BadRequestException("Not your campaign");
    }
  }

  async calculatePayment(campaignId: string, payerId: string) {
    const campaign: any = await this.campaignModel.findById(campaignId).lean();
    if (!campaign) throw new NotFoundException("Campaign not found");

    await this.assertCampaignOwner(campaign, payerId);

    const pricePerInfluencer = Number(campaign.pricePerInfluencer || 0);

    const acceptedInvites = await this.inviteModel
      .find({
        campaignId,
        status: {
          $in: [
            "accepted",
            "payment_confirmed",
            "working",
            "submitted",
            "completed",
            "disputed",
          ],
        },
      })
      .lean();

    const acceptedCount = acceptedInvites.length;
    if (acceptedCount === 0) {
      return {
        campaignId,
        campaignType: campaign.campaignType || "paid_collab",
        acceptedCount: 0,
        pricePerInfluencer,
        agreedAmount: 0,
        platformFee: 0,
        payerTotal: 0,
        recipientPayoutTotal: 0,
      };
    }

    const inviteAgreedAmounts = acceptedInvites.map((invite: any) => {
      const fromInvite = Number(invite?.agreedAmountPaise || 0);
      if (Number.isFinite(fromInvite) && fromInvite > 0) return fromInvite;
      const fallback = Number(pricePerInfluencer || 0);
      if (Number.isFinite(fallback) && fallback > 0) return fallback;
      return 0;
    });
    const agreedAmount = inviteAgreedAmounts.reduce(
      (sum, value) => sum + value,
      0,
    );
    if (!agreedAmount || agreedAmount <= 0) {
      throw new BadRequestException(
        "No valid accepted payout amounts found. Set campaign payout or invite agreed amount.",
      );
    }
    const { platformFeeEnabled, platformFeePercent } =
      await this.getFeeSettings();

    // Get effective commission percent after any overrides for the brand (payer)
    const effectiveCommissionPercent = await this.getEffectiveCommissionPercent(
      String(campaign.brandId),
      "brand",
      platformFeePercent,
    );

    const fee = platformFeeEnabled
      ? this.roundPercent(agreedAmount, effectiveCommissionPercent)
      : 0;

    const campaignType = campaign.campaignType || "paid_collab";
    let payerTotal = agreedAmount;
    let recipientPayoutTotal = agreedAmount;

    if (campaignType === "pay_to_join") {
      payerTotal = agreedAmount;
      recipientPayoutTotal = Math.max(agreedAmount - fee, 0);
    } else {
      payerTotal = agreedAmount + fee;
      recipientPayoutTotal = agreedAmount;
    }

    return {
      campaignId,
      campaignType,
      acceptedCount,
      acceptedInviteIds: acceptedInvites.map((i: any) => String(i._id)),
      acceptedInviteAgreedAmounts: inviteAgreedAmounts,
      pricePerInfluencer,
      agreedAmount,
      platformFee: fee,
      payerTotal,
      recipientPayoutTotal,
      platformFeeEnabled,
      platformFeePercent: effectiveCommissionPercent, // Use effective percent instead of global
      trustLabels: [
        "You pay only for accepted recipients",
        "Payment secured by TrendStarz",
        "Released after campaign approval",
      ],
    };
  }

  async submitPaymentProof(
    campaignId: string,
    payerId: string,
    body: { utrNumber: string; paymentProofUrl?: string },
  ) {
    const utrNumber = (body.utrNumber || "").trim();
    if (!utrNumber) {
      throw new BadRequestException("UTR number is required");
    }

    const campaign: any = await this.campaignModel.findById(campaignId).lean();
    if (!campaign) throw new NotFoundException("Campaign not found");
    await this.assertCampaignOwner(campaign, payerId);

    const calc = await this.calculatePayment(campaignId, payerId);
    if (!calc.acceptedCount) {
      throw new BadRequestException("No accepted recipients found for payment");
    }

    const acceptedInvites = await this.inviteModel
      .find({ _id: { $in: calc.acceptedInviteIds } })
      .lean();

    const paymentBatchId = `batch_${campaignId}_${Date.now()}`;

    const saved: any[] = [];

    for (let i = 0; i < acceptedInvites.length; i++) {
      const invite = acceptedInvites[i];
      const inviteAgreedAmount = Number(
        invite?.agreedAmountPaise || calc.pricePerInfluencer || 0,
      );
      if (!inviteAgreedAmount || inviteAgreedAmount <= 0) {
        throw new BadRequestException(
          `Invite ${String(invite?._id?.toString() ?? "")} has no valid agreed payout amount.`,
        );
      }
      const inviteFee = calc.platformFeeEnabled
        ? this.roundPercent(
            inviteAgreedAmount,
            Number(calc.platformFeePercent || 0),
          )
        : 0;
      const invitePayerTotal =
        calc.campaignType === "pay_to_join"
          ? inviteAgreedAmount
          : inviteAgreedAmount + inviteFee;
      const inviteRecipientPayout =
        calc.campaignType === "pay_to_join"
          ? Math.max(inviteAgreedAmount - inviteFee, 0)
          : inviteAgreedAmount;
      const influencerId = String(invite.influencerId);
      const inviteRecipientRole =
        String(invite?.recipientRole || "")
          .trim()
          .toLowerCase() === "photographer"
          ? "photographer"
          : "influencer";
      const recipientId =
        calc.campaignType === "pay_to_join"
          ? String(campaign.brandId)
          : influencerId;

      const existing = await this.transactionModel.findOne({
        campaignId,
        inviteId: invite._id,
        payerId,
      });

      const txData = {
        transactionType:
          calc.campaignType === "pay_to_join" ? "pay_to_join" : "paid_collab",
        direction:
          calc.campaignType === "pay_to_join"
            ? "influencer_to_brand"
            : "brand_to_influencer",
        campaignId,
        inviteId: invite._id,
        payerId,
        payerRole:
          calc.campaignType === "pay_to_join" ? inviteRecipientRole : "brand",
        recipientId,
        recipientRole:
          calc.campaignType === "pay_to_join" ? "brand" : inviteRecipientRole,
        agreedAmount: inviteAgreedAmount,
        platformFee: inviteFee,
        payerTotal: invitePayerTotal,
        recipientPayout: inviteRecipientPayout,
        paymentBatchId,
        utrNumber,
        paymentProofUrl: body.paymentProofUrl || undefined,
        collectionStatus: "proof_submitted",
      };

      if (existing) {
        Object.assign(existing, txData);
        saved.push(await existing.save());
      } else {
        const created = await this.transactionModel.create(txData);
        saved.push(created);
      }
    }

    // Fire-and-forget admin alert
    const adminEmail = process.env.ADMIN_EMAIL || "support@trendstarz.in";
    const adminUrl =
      (process.env.FRONTEND_URL || "https://trendstarz.com") +
      "/admin/payments";
    sendAppEmail({
      to: adminEmail,
      ...paymentProofAdminTemplate({
        campaignTitle: campaign.title || campaignId,
        utrNumber,
        recipientCount: saved.length,
        adminUrl,
      }),
    }).catch((err: unknown) => {
      console.error(
        "[PaymentsPayoutsService] Failed to send admin UTR alert:",
        err,
      );
    });

    return {
      success: true,
      message: "Payment proof submitted for admin verification",
      count: saved.length,
      transactions: saved,
    };
  }

  async listForAdmin(status?: string) {
    const filter: any = {};
    if (status === "awaiting") filter.collectionStatus = "awaiting_payment";
    if (status === "verified") filter.collectionStatus = "verified";
    if (status === "payout_pending") filter.payoutStatus = "pending";
    if (status === "paid") filter.payoutStatus = "paid";

    const rows = await this.transactionModel
      .find(filter)
      .sort({ createdAt: -1 })
      .lean();

    const inviteIds = new Set<string>();
    for (const r of rows as any[]) {
      if (r.inviteId) inviteIds.add(String(r.inviteId));
    }

    const invites = inviteIds.size
      ? await this.inviteModel
          .find({ _id: { $in: Array.from(inviteIds) } })
          .select(
            "status unlocked unlockType agreedAmount agreedAmountPaise counterOffer acceptedAt",
          )
          .lean()
      : [];
    const inviteMap = new Map<string, any>();
    for (const inv of invites as any[]) {
      inviteMap.set(String(inv._id), inv);
    }

    // Enrich rows with recipient + payer profile info so the admin UI can
    // prefill the "Mark Payout Paid" popup (name, UPI ID, mobile) without
    // an extra round-trip per row.
    const influencerIds = new Set<string>();
    const photographerIds = new Set<string>();
    const brandIds = new Set<string>();
    for (const r of rows as any[]) {
      if (r.recipientRole === "influencer" && r.recipientId) {
        influencerIds.add(String(r.recipientId));
      }
      if (r.recipientRole === "photographer" && r.recipientId) {
        photographerIds.add(String(r.recipientId));
      }
      if (r.recipientRole === "brand" && r.recipientId) {
        brandIds.add(String(r.recipientId));
      }
      if (r.payerRole === "influencer" && r.payerId) {
        influencerIds.add(String(r.payerId));
      }
      if (r.payerRole === "photographer" && r.payerId) {
        photographerIds.add(String(r.payerId));
      }
      if (r.payerRole === "brand" && r.payerId) {
        brandIds.add(String(r.payerId));
      }
    }

    const [influencers, photographers, brands] = await Promise.all([
      influencerIds.size
        ? this.influencerModel
            .find({ _id: { $in: Array.from(influencerIds) } })
            .select("name email phoneNumber payout")
            .lean()
        : Promise.resolve([] as any[]),
      photographerIds.size
        ? this.photographerModel
            .find({ _id: { $in: Array.from(photographerIds) } })
            .select("name email phoneNumber payout")
            .lean()
        : Promise.resolve([] as any[]),
      brandIds.size
        ? this.brandModel
            .find({ _id: { $in: Array.from(brandIds) } })
            .select("brandName email phoneNumber payout")
            .lean()
        : Promise.resolve([] as any[]),
    ]);

    const inflMap = new Map<string, any>();
    for (const i of influencers) inflMap.set(String(i._id), i);
    const photographerMap = new Map<string, any>();
    for (const p of photographers) photographerMap.set(String(p._id), p);
    const brandMap = new Map<string, any>();
    for (const b of brands) brandMap.set(String(b._id), b);

    const buildContact = (
      role: string | undefined,
      id: any,
    ): {
      id: string;
      role: string;
      name: string;
      email?: string;
      mobile?: string;
      payoutUpiId?: string;
      payoutMobile?: string;
      payoutName?: string;
      lastConfirmedAt?: Date | null;
    } | null => {
      if (!id) return null;
      const sid = String(id);
      if (role === "influencer") {
        const i = inflMap.get(sid);
        if (!i) return { id: sid, role: "influencer", name: "" };
        return {
          id: sid,
          role: "influencer",
          name: i.name || "",
          email: i.email || "",
          mobile: i.phoneNumber || "",
          payoutUpiId: i.payout?.upiId || "",
          payoutMobile: i.payout?.mobile || "",
          payoutName: i.payout?.accountHolderName || "",
          lastConfirmedAt: i.payout?.lastConfirmedAt || null,
        };
      }
      if (role === "brand") {
        const b = brandMap.get(sid);
        if (!b) return { id: sid, role: "brand", name: "" };
        return {
          id: sid,
          role: "brand",
          name: b.brandName || "",
          email: b.email || "",
          mobile: b.phoneNumber || "",
          payoutUpiId: b.payout?.upiId || "",
          payoutMobile: b.payout?.mobile || "",
          payoutName: b.payout?.accountHolderName || "",
          lastConfirmedAt: b.payout?.lastConfirmedAt || null,
        };
      }
      if (role === "photographer") {
        const p = photographerMap.get(sid);
        if (!p) return { id: sid, role: "photographer", name: "" };
        return {
          id: sid,
          role: "photographer",
          name: p.name || "",
          email: p.email || "",
          mobile: p.phoneNumber || "",
          payoutUpiId: p.payout?.upiId || "",
          payoutMobile: p.payout?.mobile || "",
          payoutName: p.payout?.accountHolderName || "",
          lastConfirmedAt: p.payout?.lastConfirmedAt || null,
        };
      }
      return null;
    };

    const enriched = (rows as any[]).map((r: any) => ({
      ...r,
      recipient: buildContact(r.recipientRole, r.recipientId),
      payer: buildContact(r.payerRole, r.payerId),
      inviteSnapshot: r.inviteId
        ? (() => {
            const inv = inviteMap.get(String(r.inviteId));
            if (!inv) return null;
            return {
              id: String(inv._id),
              status: String(inv.status || ""),
              unlocked: !!inv.unlocked,
              unlockType: String(inv.unlockType || ""),
              agreedAmount: Number(inv.agreedAmount || 0),
              agreedAmountPaise: Number(inv.agreedAmountPaise || 0),
              counterOfferStatus: String(inv?.counterOffer?.status || ""),
              counterOfferedAmount: Number(inv?.counterOffer?.offeredAmount || 0),
              counterOfferedAmountPaise: Number(
                inv?.counterOffer?.offeredAmountPaise || 0,
              ),
              counterRequestedAmount: Number(inv?.counterOffer?.requestedAmount || 0),
              counterRequestedAmountPaise: Number(
                inv?.counterOffer?.requestedAmountPaise || 0,
              ),
              counterResolvedAt: inv?.counterOffer?.resolvedAt || null,
              acceptedAt: inv?.acceptedAt || null,
            };
          })()
        : null,
    }));

    return { success: true, data: enriched };
  }

  async getAdminSummary() {
    const rows = await this.transactionModel.find({}).lean();
    const verified = rows.filter((r: any) => r.collectionStatus === "verified");
    const paid = rows.filter((r: any) => r.payoutStatus === "paid");
    const pending = rows.filter((r: any) => r.payoutStatus === "pending");

    const collected = verified.reduce(
      (sum: number, r: any) => sum + Number(r.payerTotal || 0),
      0,
    );
    const fees = verified.reduce(
      (sum: number, r: any) => sum + Number(r.platformFee || 0),
      0,
    );
    const pendingPayouts = pending.reduce(
      (sum: number, r: any) => sum + Number(r.recipientPayout || 0),
      0,
    );
    const paidOut = paid.reduce(
      (sum: number, r: any) => sum + Number(r.recipientPayout || 0),
      0,
    );

    return {
      success: true,
      data: {
        collected,
        fees,
        pendingPayouts,
        paidOut,
        netBalance: collected - paidOut - pendingPayouts,
      },
    };
  }

  async verifyCollection(transactionId: string, notes?: string) {
    const tx = await this.transactionModel.findById(transactionId);
    if (!tx) throw new NotFoundException("Transaction not found");

    if (String(tx.gateway || "manual_upi") !== "manual_upi") {
      throw new BadRequestException(
        "This transaction is configured for auto settlement via payment gateway. Manual mark-paid is disabled.",
      );
    }
    tx.collectionStatus = "verified";
    tx.collectedAt = new Date();
    if (notes) tx.adminNotes = notes;

    if (tx.workStatus === "approved") {
      tx.payoutStatus = "processing";
    } else if (!tx.payoutStatus) {
      tx.payoutStatus = "pending";
    }
    if (tx.payoutStatus === "pending" && tx.workStatus === "approved") {
      tx.payoutStatus = "processing";
    }

    await tx.save();

    // Brand pays → unlock contact for the linked invite (paid_collab payment path).
    // Also advance invite status to payment_confirmed if still in accepted.
    let paymentConfirmedRecipientId: string | null = null;
    let paymentConfirmedRecipientRole: "influencer" | "photographer" =
      "influencer";
    let paymentConfirmedCampaignId: string | null = null;
    if (tx.inviteId && tx.transactionType === "paid_collab") {
      const update: any = {
        unlocked: true,
        unlockedAt: new Date(),
        unlockType: "paid_collab_payment",
        updatedAt: new Date(),
      };
      const invite: any = await this.inviteModel
        .findById(tx.inviteId)
        .select("status influencerId campaignId recipientRole")
        .lean();
      if (invite && invite.status === "accepted") {
        update.status = "payment_confirmed";
        paymentConfirmedRecipientId = String(invite.influencerId || "");
        paymentConfirmedRecipientRole =
          String(invite?.recipientRole || "")
            .trim()
            .toLowerCase() === "photographer"
            ? "photographer"
            : "influencer";
        paymentConfirmedCampaignId = String(invite.campaignId || "");
      }
      await this.inviteModel.findByIdAndUpdate(tx.inviteId, { $set: update });
    }

    // Notify recipient as soon as payment is confirmed so they can start posting.
    if (paymentConfirmedRecipientId) {
      Promise.all([
        (paymentConfirmedRecipientRole === "photographer"
          ? this.photographerModel
          : this.influencerModel
        )
          .findById(paymentConfirmedRecipientId)
          .select("email name username")
          .lean(),
        paymentConfirmedCampaignId
          ? this.campaignModel
              .findById(paymentConfirmedCampaignId)
              .select("title")
              .lean()
          : Promise.resolve(null),
      ])
        .then(([inf, campaign]: any[]) => {
          if (!inf?.email) return;
          const name = inf.name || inf.username || "Creator";
          const campaignTitle = campaign?.title || "your campaign";
          const dashboardUrl =
            (process.env.FRONTEND_URL || "https://trendstarz.com") +
            (paymentConfirmedRecipientRole === "photographer"
              ? "/photographer-dashboard"
              : "/influencer-dashboard");
          return sendAppEmail({
            to: inf.email,
            ...paymentVerifiedInfluencerTemplate({
              recipientName: name,
              campaignTitle,
              dashboardUrl,
            }),
          });
        })
        .catch((err: unknown) => {
          console.error(
            "[PaymentsPayoutsService] Failed to send payment-confirmed email to recipient:",
            err,
          );
        });

      // Web push
      this.pushService
        .sendToUser(paymentConfirmedRecipientId, {
          title: "Payment verified ✅",
          body: `You can now start posting for your campaign.`,
          url:
            paymentConfirmedRecipientRole === "photographer"
              ? "/photographer-dashboard"
              : "/influencer-dashboard",
        })
        .catch(() => {
          /* non-critical */
        });
      this.notificationsService
        .createForUser({
          userId: paymentConfirmedRecipientId,
          userRole: paymentConfirmedRecipientRole,
          title: "Payment Verified",
          body: "Brand payment was verified. You can start working on the campaign.",
          url:
            paymentConfirmedRecipientRole === "photographer"
              ? "/photographer-dashboard"
              : "/influencer-dashboard",
        })
        .catch(() => {
          /* non-critical */
        });
    }

    // Fire-and-forget: notify brand their payment was verified
    if (tx.payerId) {
      this.brandModel
        .findById(tx.payerId)
        .select("email brandName")
        .lean()
        .then((brand: any) => {
          if (!brand?.email) return;
          const name = brand.brandName || "Brand";
          const adminUrl =
            (process.env.FRONTEND_URL || "https://trendstarz.com") +
            "/campaigns";
          sendAppEmail({
            to: brand.email,
            ...paymentVerifiedBrandTemplate({
              brandName: name,
              dashboardUrl: adminUrl,
            }),
          }).catch((err: unknown) => {
            console.error(
              "[PaymentsPayoutsService] Failed to send verification email to brand:",
              err,
            );
          });
        })
        .catch(() => {
          /* ignore */
        });

      this.notificationsService
        .createForUser({
          userId: String(tx.payerId),
          userRole: "brand",
          title: "Payment Verified",
          body: "Your campaign payment is verified and influencers can now start work.",
          url: "/campaign-management",
        })
        .catch(() => {
          /* non-critical */
        });
    }

    return { success: true, transaction: tx };
  }

  async rejectCollection(transactionId: string, reason: string) {
    const tx = await this.transactionModel.findById(transactionId);
    if (!tx) throw new NotFoundException("Transaction not found");
    tx.collectionStatus = "failed";
    tx.adminNotes = reason || "Payment proof rejected";
    await tx.save();

    // Fire-and-forget: notify brand their UTR was rejected
    if (tx.payerId) {
      this.brandModel
        .findById(tx.payerId)
        .select("email brandName")
        .lean()
        .then((brand: any) => {
          if (!brand?.email) return;
          const name = brand.brandName || "Brand";
          const payUrl =
            (process.env.FRONTEND_URL || "https://trendstarz.com") +
            "/campaigns";
          sendAppEmail({
            to: brand.email,
            ...paymentRejectedTemplate({
              brandName: name,
              reason,
              resubmitUrl: payUrl,
            }),
          }).catch((err: unknown) => {
            console.error(
              "[PaymentsPayoutsService] Failed to send rejection email to brand:",
              err,
            );
          });
        })
        .catch(() => {
          /* ignore */
        });
    }

    return { success: true, transaction: tx };
  }

  async markPayoutPaid(
    transactionId: string,
    body: {
      payoutUtr: string;
      payoutProofUrl?: string;
      payoutUpiId?: string;
      notes?: string;
    },
  ) {
    const tx = await this.transactionModel.findById(transactionId);
    if (!tx) throw new NotFoundException("Transaction not found");

    if (tx.inviteId) {
      const invite: any = await this.inviteModel
        .findById(tx.inviteId)
        .select("status")
        .lean();
      const inviteStatus = String(invite?.status || "").toLowerCase();
      const payoutEligibleStatuses = new Set([
        "accepted",
        "payment_confirmed",
        "working",
        "submitted",
        "completed",
        "approved",
      ]);
      if (!payoutEligibleStatuses.has(inviteStatus)) {
        throw new BadRequestException(
          "Invite must be accepted or progressed before payout release.",
        );
      }
    }

    if (tx.collectionStatus !== "verified") {
      throw new BadRequestException(
        "Collection must be verified before payout",
      );
    }
    if (tx.disputeStatus === "open") {
      throw new BadRequestException(
        "Cannot mark payout as paid while a dispute is open. Resolve the dispute first.",
      );
    }
    tx.payoutStatus = "paid";
    tx.paidOutAt = new Date();
    tx.payoutUtr = body.payoutUtr;
    if (body.payoutProofUrl) tx.payoutProofUrl = body.payoutProofUrl;
    if (body.payoutUpiId) tx.payoutUpiId = body.payoutUpiId;
    if (body.notes) tx.adminNotes = body.notes;
    await tx.save();

    // Fire-and-forget: notify influencer their payout has been sent
    if (
      tx.recipientId &&
      (tx.recipientRole === "influencer" || tx.recipientRole === "photographer")
    ) {
      (tx.recipientRole === "photographer"
        ? this.photographerModel
        : this.influencerModel
      )
        .findById(tx.recipientId)
        .select("email name username")
        .lean()
        .then((inf: any) => {
          if (!inf?.email) return;
          const name = inf.name || inf.username || "Creator";
          const amount =
            tx.recipientPayout != null
              ? `₹${(tx.recipientPayout / 100).toFixed(2)}`
              : "your payout";
          sendAppEmail({
            to: inf.email,
            ...payoutSentTemplate({
              recipientName: name,
              amount,
              upiId: tx.payoutUpiId || null,
              payoutUtr: tx.payoutUtr,
            }),
          }).catch((err: unknown) => {
            console.error(
              "[PaymentsPayoutsService] Failed to send payout email:",
              err,
            );
          });
        })
        .catch(() => {
          /* ignore */
        });
    }

    return { success: true, transaction: tx };
  }

  async listMine(userId: string, role: string) {
    const normalizedRole = ["brand", "influencer", "photographer"].includes(
      String(role || "").toLowerCase(),
    )
      ? String(role || "").toLowerCase()
      : "influencer";
    const rows = await this.transactionModel
      .find({ $or: [{ payerId: userId }, { recipientId: userId }] })
      .sort({ createdAt: -1 })
      .lean();

    // Collect IDs to look up in bulk
    const campaignIds = new Set<string>();
    const influencerIds = new Set<string>();
    const photographerIds = new Set<string>();
    const brandIds = new Set<string>();
    for (const r of rows as any[]) {
      if (r.campaignId) campaignIds.add(String(r.campaignId));
      if (r.recipientRole === "influencer" && r.recipientId)
        influencerIds.add(String(r.recipientId));
      if (r.payerRole === "influencer" && r.payerId)
        influencerIds.add(String(r.payerId));
      if (r.recipientRole === "photographer" && r.recipientId)
        photographerIds.add(String(r.recipientId));
      if (r.payerRole === "photographer" && r.payerId)
        photographerIds.add(String(r.payerId));
      if (r.recipientRole === "brand" && r.recipientId)
        brandIds.add(String(r.recipientId));
      if (r.payerRole === "brand" && r.payerId) brandIds.add(String(r.payerId));
    }

    const [campaigns, influencers, photographers, brands] = await Promise.all([
      campaignIds.size
        ? this.campaignModel
            .find({ _id: { $in: Array.from(campaignIds) } })
            .select("title campaignType image")
            .lean()
        : Promise.resolve([] as any[]),
      influencerIds.size
        ? this.influencerModel
            .find({ _id: { $in: Array.from(influencerIds) } })
            .select("name username")
            .lean()
        : Promise.resolve([] as any[]),
      photographerIds.size
        ? this.photographerModel
            .find({ _id: { $in: Array.from(photographerIds) } })
            .select("name username")
            .lean()
        : Promise.resolve([] as any[]),
      brandIds.size
        ? this.brandModel
            .find({ _id: { $in: Array.from(brandIds) } })
            .select("brandName brandUsername brandLogo")
            .lean()
        : Promise.resolve([] as any[]),
    ]);

    const campaignMap = new Map<string, any>();
    for (const c of campaigns) campaignMap.set(String(c._id), c);
    const inflMap = new Map<string, any>();
    for (const i of influencers) inflMap.set(String(i._id), i);
    const photographerMap = new Map<string, any>();
    for (const p of photographers) photographerMap.set(String(p._id), p);
    const brandMap = new Map<string, any>();
    for (const b of brands) brandMap.set(String(b._id), b);

    const getPartyName = (role: string, id: any): string => {
      const sid = String(id);
      if (role === "influencer") return inflMap.get(sid)?.name || "";
      if (role === "photographer") return photographerMap.get(sid)?.name || "";
      if (role === "brand")
        return brandMap.get(sid)?.name || brandMap.get(sid)?.brandName || "";
      return "";
    };

    const getPartyLogo = (role: string, id: any): string => {
      if (role !== "brand") return "";
      const b = brandMap.get(String(id));
      const logo = Array.isArray(b?.brandLogo) ? b.brandLogo[0] : b?.brandLogo;
      return (
        logo?.url || logo?.secure_url || (typeof logo === "string" ? logo : "")
      );
    };

    const getBrandLogoForRow = (r: any): string => {
      // Always show the brand logo in the avatar, regardless of viewer role.
      // For paid_collab the brand is the payer; for pay_to_join the brand is the recipient.
      const brandRole = r.payerRole === "brand" ? "payer" : "recipient";
      const brandId = brandRole === "payer" ? r.payerId : r.recipientId;
      return getPartyLogo("brand", brandId);
    };

    const enriched = (rows as any[]).map((r: any) => {
      const campaign = campaignMap.get(String(r.campaignId));
      // "other party" from the current user's perspective
      const otherRole =
        normalizedRole === "influencer" ? r.payerRole : r.recipientRole;
      const otherId =
        normalizedRole === "influencer" ? r.payerId : r.recipientId;
      return {
        ...r,
        campaignTitle: campaign?.title || "",
        campaignType: r.transactionType || campaign?.campaignType || "",
        otherPartyName: getPartyName(otherRole, otherId),
        otherPartyRole: otherRole,
        // Always show brand logo; falls back to campaign cover image then TrendstarZ in frontend
        otherPartyLogo: getBrandLogoForRow(r) || campaign?.image?.url || "",
      };
    });

    return { success: true, data: enriched };
  }

  // ── Campaign-level status (brand polls this after submitting UTR) ────────────

  /** Brand (or influencer) — get all transactions for one campaign. */
  async getForCampaign(campaignId: string, userId: string) {
    const campaign: any = await this.campaignModel.findById(campaignId).lean();
    if (!campaign) throw new NotFoundException("Campaign not found");
    await this.assertCampaignOwner(campaign, userId);

    const rows = await this.transactionModel
      .find({ campaignId })
      .sort({ createdAt: -1 })
      .lean();

    return { success: true, data: rows };
  }

  // ── Dispute — raise (brand or influencer), resolve (admin) ──────────────────

  /**
   * Raise a payment-level dispute.
   * Sets payoutStatus → 'frozen' so money cannot move until admin resolves.
   * Can be called by brand (if payment already made, wants refund for non-delivery)
   * or influencer (if work approved but payout withheld).
   */
  async raiseDispute(
    txId: string,
    userId: string,
    userRole: "brand" | "influencer" | "photographer",
    reason: string,
  ) {
    if (!reason?.trim()) {
      throw new BadRequestException("A reason is required to raise a dispute");
    }
    const tx = await this.transactionModel.findById(txId);
    if (!tx) throw new NotFoundException("Transaction not found");

    // Guard: only parties involved in the transaction can raise a dispute
    const isBrand = userRole === "brand" && String(tx.payerId) === userId;
    const isInfluencer =
      userRole === "influencer" && String(tx.recipientId) === userId;
    const isPhotographer =
      userRole === "photographer" && String(tx.recipientId) === userId;
    if (!isBrand && !isInfluencer && !isPhotographer) {
      throw new BadRequestException("You are not a party to this transaction");
    }
    if (tx.disputeStatus === "open") {
      throw new BadRequestException(
        "A dispute is already open for this transaction",
      );
    }
    if (tx.disputeStatus === "resolved") {
      throw new BadRequestException(
        "This transaction dispute is already resolved",
      );
    }

    tx.disputeStatus = "open";
    tx.disputeReason = reason.trim();
    tx.disputedBy = userId;
    tx.disputedByRole = userRole;
    tx.disputedAt = new Date();
    // Freeze payout — admin must explicitly release after review
    if (tx.payoutStatus !== "paid") {
      tx.payoutStatus = "frozen";
    }
    if (tx.workStatus !== "disputed") {
      tx.workStatus = "disputed";
    }
    await tx.save();

    const counterpartId =
      userRole === "brand" ? String(tx.recipientId) : String(tx.payerId);
    const counterpartRole = userRole === "brand" ? tx.recipientRole : "brand";
    this.notificationsService
      .createForUser({
        userId: counterpartId,
        userRole: counterpartRole,
        title: "Dispute Raised",
        body: "A dispute was raised on a campaign transaction involving you.",
        url:
          counterpartRole === "brand"
            ? "/transactions"
            : counterpartRole === "photographer"
              ? "/photographer-dashboard"
              : "/influencer-dashboard",
      })
      .catch(() => {
        /* non-critical */
      });

    return {
      success: true,
      message: "Dispute raised. Payout is frozen pending admin review.",
      transaction: tx,
    };
  }

  /**
   * Admin resolves a frozen dispute.
   * outcome: 'release_to_influencer' → send payout to influencer (work was valid).
   * outcome: 'refund_to_brand' → refund brand (non-delivery / invalid work).
   */
  async resolveDispute(
    txId: string,
    adminId: string,
    outcome: "release_to_influencer" | "refund_to_brand",
    notes?: string,
  ) {
    const tx = await this.transactionModel.findById(txId);
    if (!tx) throw new NotFoundException("Transaction not found");
    if (tx.disputeStatus !== "open") {
      throw new BadRequestException("No open dispute on this transaction");
    }
    if (!["release_to_influencer", "refund_to_brand"].includes(outcome)) {
      throw new BadRequestException(
        "Invalid outcome. Use release_to_influencer or refund_to_brand",
      );
    }

    tx.disputeStatus = "resolved";
    tx.resolveOutcome = outcome;
    tx.resolvedBy = adminId;
    tx.resolvedAt = new Date();
    if (notes) tx.adminNotes = notes;

    if (outcome === "release_to_influencer") {
      // Work was valid — release payout flow
      tx.payoutStatus = "processing";
      tx.workStatus = "approved";
    } else {
      // Non-delivery / invalid — mark as refunded
      tx.payoutStatus = "skipped";
      tx.workStatus = "disputed"; // keep for audit
    }

    await tx.save();

    // If releasing to influencer — also mark the invite as completed
    if (outcome === "release_to_influencer" && tx.inviteId) {
      await this.inviteModel.findByIdAndUpdate(tx.inviteId, {
        $set: { status: "completed" },
      });
    }

    const resolutionMessage =
      outcome === "release_to_influencer"
        ? "Dispute resolved. Payout released to influencer."
        : "Dispute resolved. Payment will be refunded to brand.";
    this.notificationsService
      .createForUser({
        userId: String(tx.payerId),
        userRole: "brand",
        title: "Dispute Resolved",
        body: resolutionMessage,
        url: "/transactions",
      })
      .catch(() => {
        /* non-critical */
      });
    this.notificationsService
      .createForUser({
        userId: String(tx.recipientId),
        userRole: tx.recipientRole,
        title: "Dispute Resolved",
        body: resolutionMessage,
        url:
          tx.recipientRole === "photographer"
            ? "/photographer-dashboard"
            : "/influencer-dashboard",
      })
      .catch(() => {
        /* non-critical */
      });

    return {
      success: true,
      message:
        outcome === "release_to_influencer"
          ? "Dispute resolved. Payout released to influencer."
          : "Dispute resolved. Payment will be refunded to brand.",
      transaction: tx,
    };
  }

  /** Admin — list all open disputes (frozen transactions). */
  async listOpenDisputes() {
    const rows = await this.transactionModel
      .find({ disputeStatus: "open" })
      .sort({ disputedAt: 1 })
      .lean();
    return { success: true, data: rows, total: rows.length };
  }
}
