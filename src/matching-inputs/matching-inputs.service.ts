import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Types } from "mongoose";
import { SocialAccountObservationService } from "../social-account-observation/social-account-observation.service";
import { SocialAccountVerificationService } from "../social-account-verification/social-account-verification.service";
import {
  EvidenceByAccount,
  NormalizedCampaignMatchInput,
  NormalizedCreatorMatchInput,
  normalizeCampaignMatchInput,
  normalizeCreatorMatchInput,
} from "./matching-inputs";

/**
 * Stage 3B-1 — loads a creator or campaign (read-only) and returns its
 * normalized matching input. Evidence comes from the Stage 3A-1/3A-2 read
 * methods (listForProfile) — never observe()/decide(). No writes, no platform
 * or AI calls, no scoring.
 */
@Injectable()
export class MatchingInputsService {
  constructor(
    @InjectModel("Influencer") private readonly influencerModel: Model<any>,
    @InjectModel("Photographer") private readonly photographerModel: Model<any>,
    @InjectModel("Campaign") private readonly campaignModel: Model<any>,
    private readonly verification: SocialAccountVerificationService,
    private readonly observation: SocialAccountObservationService,
  ) {}

  async forCreator(
    type: string,
    id: string,
  ): Promise<NormalizedCreatorMatchInput> {
    const profileType =
      String(type).toLowerCase() === "photographer"
        ? "Photographer"
        : String(type).toLowerCase() === "influencer"
          ? "Influencer"
          : null;
    if (!profileType)
      throw new BadRequestException("type must be influencer or photographer");
    if (!Types.ObjectId.isValid(id))
      throw new BadRequestException("Invalid id");
    const model =
      profileType === "Photographer"
        ? this.photographerModel
        : this.influencerModel;
    const profile: any = await model.findById(id).lean();
    if (!profile) throw new NotFoundException("Creator not found");

    const [verifications, observations] = await Promise.all([
      this.verification.listForProfile(
        profileType,
        String(id),
        profile.socialMedia,
      ),
      this.observation.listForProfile(
        profileType,
        String(id),
        profile.socialMedia,
      ),
    ]);
    const evidence: EvidenceByAccount = {
      verification: new Map(
        verifications
          .filter((v) => v.socialAccountId)
          .map((v) => [
            String(v.socialAccountId),
            {
              ownership: v.ownershipVerification?.status,
              tier: v.tierVerification?.status,
            },
          ]),
      ),
      observation: new Map(
        observations
          .filter((o) => o.socialAccountId)
          .map((o) => [
            String(o.socialAccountId),
            {
              available: !!o.observation?.latest,
              followersAvailable:
                o.observation?.latest?.observedFollowersCount != null,
            },
          ]),
      ),
    };
    return normalizeCreatorMatchInput(profile, profileType, evidence);
  }

  async forCampaign(id: string): Promise<NormalizedCampaignMatchInput> {
    return (await this.forCampaignWithTitle(id)).input;
  }

  async forCampaignWithTitle(
    id: string,
  ): Promise<{ input: NormalizedCampaignMatchInput; title: string }> {
    if (!Types.ObjectId.isValid(id))
      throw new BadRequestException("Invalid id");
    const campaign: any = await this.campaignModel.findById(id).lean();
    if (!campaign) throw new NotFoundException("Campaign not found");
    return {
      input: normalizeCampaignMatchInput(campaign),
      title: String(campaign.title || campaign.campaignTitle || "").trim(),
    };
  }

  /**
   * Stage 3B-3 — every non-deleted creator of one type, normalized in one
   * read. Per-account verification/observation evidence is NOT loaded: it never
   * affects eligibility, and loading it per creator would be N extra queries
   * (the single-creator endpoint still returns it).
   */
  async forAllCreators(profileType: "Influencer" | "Photographer"): Promise<
    Array<{
      input: NormalizedCreatorMatchInput;
      display: { name: string; username: string; publicId: string };
    }>
  > {
    const model =
      profileType === "Photographer"
        ? this.photographerModel
        : this.influencerModel;
    const profiles: any[] = await model
      .find({ isDeleted: { $ne: true } })
      .select("-password")
      .lean();
    const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
    return profiles.map((profile) => ({
      input: normalizeCreatorMatchInput(profile, profileType),
      display: {
        name: str(profile.name),
        username: str(profile.username),
        publicId: str(profile.publicId),
      },
    }));
  }
}
