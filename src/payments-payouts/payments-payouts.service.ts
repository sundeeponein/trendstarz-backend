import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";

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
  ) {}

  private roundPercent(amount: number, percent: number): number {
    return Math.round((amount * percent) / 100);
  }

  private splitEvenly(total: number, parts: number): number[] {
    if (parts <= 0) return [];
    const base = Math.floor(total / parts);
    const remainder = total % parts;
    return Array.from({ length: parts }, (_, i) => base + (i < remainder ? 1 : 0));
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
    const { platformFeeEnabled, platformFeePercent } = await this.getFeeSettings();
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
      throw new BadRequestException("No accepted influencers found for payment");
    }

    const acceptedInvites = await this.inviteModel
      .find({ _id: { $in: calc.acceptedInviteIds } })
      .lean();

    const agreedSplit = this.splitEvenly(calc.agreedAmount, acceptedInvites.length);
    const feeSplit = this.splitEvenly(calc.platformFee, acceptedInvites.length);
    const payerSplit = this.splitEvenly(calc.payerTotal, acceptedInvites.length);
    const payoutSplit = this.splitEvenly(
      calc.recipientPayoutTotal,
      acceptedInvites.length,
    );

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
    for (const i of influencers as any[]) inflMap.set(String(i._id), i);
    const brandMap = new Map<string, any>();
    for (const b of brands as any[]) brandMap.set(String(b._id), b);

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
    return { success: true, transaction: tx };
  }

  async rejectCollection(transactionId: string, reason: string) {
    const tx = await this.transactionModel.findById(transactionId);
    if (!tx) throw new NotFoundException("Transaction not found");
    tx.collectionStatus = "failed";
    tx.adminNotes = reason || "Payment proof rejected";
    await tx.save();
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
      throw new BadRequestException("Collection must be verified before payout");
    }
    tx.payoutStatus = "paid";
    tx.paidOutAt = new Date();
    tx.payoutUtr = body.payoutUtr;
    if (body.payoutProofUrl) tx.payoutProofUrl = body.payoutProofUrl;
    if (body.payoutUpiId) tx.payoutUpiId = body.payoutUpiId;
    if (body.notes) tx.adminNotes = body.notes;
    await tx.save();
    return { success: true, transaction: tx };
  }

  async listMine(userId: string, role: string) {
    const normalizedRole =
      role === "brand" || role === "BRAND" ? "brand" : "influencer";
    const filter =
      normalizedRole === "brand"
        ? { $or: [{ payerId: userId }, { recipientId: userId }] }
        : { $or: [{ payerId: userId }, { recipientId: userId }] };
    const rows = await this.transactionModel
      .find(filter)
      .sort({ createdAt: -1 })
      .lean();
    return { success: true, data: rows };
  }
}
