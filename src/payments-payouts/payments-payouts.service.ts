import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import { sendAppEmail } from "../utils/app-email.service";
import { PushService } from "../push/push.service";

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
    private readonly pushService: PushService,
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
    if (!pricePerInfluencer || pricePerInfluencer <= 0) {
      throw new BadRequestException("pricePerInfluencer must be set in paise");
    }

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

    const agreedAmount = pricePerInfluencer * acceptedCount;
    const { platformFeeEnabled, platformFeePercent } =
      await this.getFeeSettings();
    const fee = platformFeeEnabled
      ? this.roundPercent(agreedAmount, platformFeePercent)
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
      pricePerInfluencer,
      agreedAmount,
      platformFee: fee,
      payerTotal,
      recipientPayoutTotal,
      platformFeeEnabled,
      platformFeePercent,
      trustLabels: [
        "You pay only for accepted influencers",
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
      throw new BadRequestException(
        "No accepted influencers found for payment",
      );
    }

    const acceptedInvites = await this.inviteModel
      .find({ _id: { $in: calc.acceptedInviteIds } })
      .lean();

    const agreedSplit = this.splitEvenly(
      calc.agreedAmount,
      acceptedInvites.length,
    );
    const feeSplit = this.splitEvenly(calc.platformFee, acceptedInvites.length);
    const payerSplit = this.splitEvenly(
      calc.payerTotal,
      acceptedInvites.length,
    );
    const payoutSplit = this.splitEvenly(
      calc.recipientPayoutTotal,
      acceptedInvites.length,
    );
    const paymentBatchId = `batch_${campaignId}_${Date.now()}`;

    const saved: any[] = [];

    for (let i = 0; i < acceptedInvites.length; i++) {
      const invite = acceptedInvites[i];
      const influencerId = String(invite.influencerId);
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
        payerRole: calc.campaignType === "pay_to_join" ? "influencer" : "brand",
        recipientId,
        recipientRole:
          calc.campaignType === "pay_to_join" ? "brand" : "influencer",
        agreedAmount: agreedSplit[i],
        platformFee: feeSplit[i],
        payerTotal: payerSplit[i],
        recipientPayout: payoutSplit[i],
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
      subject: `[TrendStarZ] New payment proof — ${campaign.title || campaignId}`,
      text: `A brand has submitted a UTR reference for campaign "${campaign.title || campaignId}".\n\nUTR: ${utrNumber}\nInfluencers: ${saved.length}\n\nReview: ${adminUrl}`,
      html: `<p>A brand has submitted a UTR reference for campaign <strong>${campaign.title || campaignId}</strong>.</p><p><strong>UTR:</strong> ${utrNumber}<br/><strong>Influencers:</strong> ${saved.length}</p><p><a href="${adminUrl}">Review in admin panel</a></p>`,
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

    // Enrich rows with recipient + payer profile info so the admin UI can
    // prefill the "Mark Payout Paid" popup (name, UPI ID, mobile) without
    // an extra round-trip per row.
    const influencerIds = new Set<string>();
    const brandIds = new Set<string>();
    for (const r of rows as any[]) {
      if (r.recipientRole === "influencer" && r.recipientId) {
        influencerIds.add(String(r.recipientId));
      }
      if (r.recipientRole === "brand" && r.recipientId) {
        brandIds.add(String(r.recipientId));
      }
      if (r.payerRole === "influencer" && r.payerId) {
        influencerIds.add(String(r.payerId));
      }
      if (r.payerRole === "brand" && r.payerId) {
        brandIds.add(String(r.payerId));
      }
    }

    const [influencers, brands] = await Promise.all([
      influencerIds.size
        ? this.influencerModel
            .find({ _id: { $in: Array.from(influencerIds) } })
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
      return null;
    };

    const enriched = (rows as any[]).map((r: any) => ({
      ...r,
      recipient: buildContact(r.recipientRole, r.recipientId),
      payer: buildContact(r.payerRole, r.payerId),
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
    let paymentConfirmedInfluencerId: string | null = null;
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
        .select("status influencerId campaignId")
        .lean();
      if (invite && invite.status === "accepted") {
        update.status = "payment_confirmed";
        paymentConfirmedInfluencerId = String(invite.influencerId || "");
        paymentConfirmedCampaignId = String(invite.campaignId || "");
      }
      await this.inviteModel.findByIdAndUpdate(tx.inviteId, { $set: update });
    }

    // Notify influencer as soon as payment is confirmed so they can start posting.
    if (paymentConfirmedInfluencerId) {
      Promise.all([
        this.influencerModel
          .findById(paymentConfirmedInfluencerId)
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
          const name = inf.name || inf.username || "Influencer";
          const campaignTitle = campaign?.title || "your campaign";
          const dashboardUrl =
            (process.env.FRONTEND_URL || "https://trendstarz.com") +
            "/influencer-dashboard";
          return sendAppEmail({
            to: inf.email,
            subject: "[TrendStarZ] Verified - you can start posting",
            text: `Hi ${name},\n\nGood news! Brand payment has been verified for "${campaignTitle}".\nYou can now start creating and posting your content.\n\nOpen dashboard: ${dashboardUrl}`,
            html: `<p>Hi <strong>${name}</strong>,</p><p>Good news! Brand payment has been verified for <strong>"${campaignTitle}"</strong>.</p><p>You can now start creating and posting your content.</p><p><a href="${dashboardUrl}">Open your dashboard</a></p>`,
          });
        })
        .catch((err: unknown) => {
          console.error(
            "[PaymentsPayoutsService] Failed to send payment-confirmed email to influencer:",
            err,
          );
        });

      // Web push
      this.pushService.sendToUser(paymentConfirmedInfluencerId, {
        title: "Payment verified ✅",
        body: `You can now start posting for your campaign.`,
        url: "/influencer-dashboard",
      }).catch(() => { /* non-critical */ });
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
            subject:
              "[TrendStarZ] Payment verified — influencers can now begin work",
            text: `Hi ${name},\n\nYour campaign payment has been verified. Influencers have been notified and can now begin creating content.\n\nMonitor progress: ${adminUrl}`,
            html: `<p>Hi <strong>${name}</strong>,</p><p>Your campaign payment has been verified! Influencers have been notified and can now begin creating content.</p><p><a href="${adminUrl}">Monitor campaign progress</a></p>`,
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
            subject:
              "[TrendStarZ] Action required — payment proof could not be verified",
            text: `Hi ${name},\n\nUnfortunately, your payment proof could not be verified.\n\nReason: ${reason || "No reason provided."}\n\nPlease resubmit with a valid UTR reference: ${payUrl}`,
            html: `<p>Hi <strong>${name}</strong>,</p><p>Unfortunately, your payment proof could not be verified.</p><p><strong>Reason:</strong> ${reason || "No reason provided."}</p><p>Please <a href="${payUrl}">log in and resubmit</a> with a valid UTR reference.</p>`,
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
    if (tx.recipientId && tx.recipientRole === "influencer") {
      this.influencerModel
        .findById(tx.recipientId)
        .select("email name username")
        .lean()
        .then((inf: any) => {
          if (!inf?.email) return;
          const name = inf.name || inf.username || "Influencer";
          const amount =
            tx.recipientPayout != null
              ? `₹${(tx.recipientPayout / 100).toFixed(2)}`
              : "your payout";
          sendAppEmail({
            to: inf.email,
            subject: "[TrendStarZ] Your payout has been sent!",
            text: `Hi ${name},\n\nGreat news! ${amount} has been sent to your UPI account (${tx.payoutUpiId || "on file"}).\n\nUTR Reference: ${tx.payoutUtr}\n\nThank you for collaborating with TrendStarZ!`,
            html: `<p>Hi <strong>${name}</strong>,</p><p>Great news! <strong>${amount}</strong> has been sent to your UPI account (<strong>${tx.payoutUpiId || "on file"}</strong>).</p><p><strong>UTR Reference:</strong> ${tx.payoutUtr}</p><p>Thank you for collaborating with TrendStarZ!</p>`,
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
    const normalizedRole =
      role === "brand" || role === "BRAND" ? "brand" : "influencer";
    const rows = await this.transactionModel
      .find({ $or: [{ payerId: userId }, { recipientId: userId }] })
      .sort({ createdAt: -1 })
      .lean();

    // Collect IDs to look up in bulk
    const campaignIds = new Set<string>();
    const influencerIds = new Set<string>();
    const brandIds = new Set<string>();
    for (const r of rows as any[]) {
      if (r.campaignId) campaignIds.add(String(r.campaignId));
      if (r.recipientRole === "influencer" && r.recipientId)
        influencerIds.add(String(r.recipientId));
      if (r.payerRole === "influencer" && r.payerId)
        influencerIds.add(String(r.payerId));
      if (r.recipientRole === "brand" && r.recipientId)
        brandIds.add(String(r.recipientId));
      if (r.payerRole === "brand" && r.payerId) brandIds.add(String(r.payerId));
    }

    const [campaigns, influencers, brands] = await Promise.all([
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
    const brandMap = new Map<string, any>();
    for (const b of brands) brandMap.set(String(b._id), b);

    const getPartyName = (role: string, id: any): string => {
      const sid = String(id);
      if (role === "influencer") return inflMap.get(sid)?.name || "";
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
    userRole: "brand" | "influencer",
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
    if (!isBrand && !isInfluencer) {
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
