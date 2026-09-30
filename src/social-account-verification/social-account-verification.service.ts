import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import {
  SocialProfileType,
  SocialReviewType,
  SocialVerificationStatus,
} from "../database/schemas/social-account-verification.schema";
import {
  derivePlatformKey,
  isSocialAccountId,
} from "../utils/social-account.util";
import { resolveTier } from "../utils/tier-ranges.util";

/**
 * Stage 3A-1 — per-social-account verification.
 *
 * Two independent admin decisions per account (ownership, tier), each tied to
 * the stable socialAccountId and to a snapshot of what was reviewed. Nothing
 * here verifies anything automatically, rewrites a declared tier, reads or
 * writes creatorTierVerified, or touches profile flags / discovery.
 */

const DECIDED_STATUSES = ["verified", "rejected"] as const;
const ADMIN_ROLES = ["admin", "subadmin"];
const NOTE_MAX_LENGTH = 1000;

const PROFILE_TYPES: Record<string, SocialProfileType> = {
  influencer: "Influencer",
  brand: "Brand",
  photographer: "Photographer",
};

export interface SocialDecisionBody {
  status?: unknown;
  note?: unknown;
  /** Precondition only: the handle/tier the admin was looking at. Never stored. */
  expectedHandle?: unknown;
  expectedTier?: unknown;
}

export interface SocialDecisionView {
  status: SocialVerificationStatus;
  method?: string;
  decidedHandle?: string;
  decidedTier?: string;
  decidedAt?: Date;
  decidedById?: string;
  decidedByName?: string;
  decidedByRole?: string;
  note?: string;
  invalidatedAt?: Date;
  invalidatedReason?: string;
  lastDecision?: Record<string, any>;
  /** True when a stored decision no longer matches the current handle/tier. */
  stale?: boolean;
}

export function toSocialProfileType(type: unknown): SocialProfileType {
  const profileType =
    PROFILE_TYPES[String(typeof type === "string" ? type : "").toLowerCase()];
  if (!profileType) throw new BadRequestException("Unsupported user type");
  return profileType;
}

/** Handles are compared the way platforms treat them: no "@", case-insensitive. */
export function handleIdentity(handle: unknown): string {
  return (typeof handle === "string" ? handle : "")
    .trim()
    .replace(/^@+/, "")
    .toLowerCase();
}

/** Tiers are compared by canonical key, so "Mid tier" and "Mid-Tier" are the same tier. */
export function tierIdentity(tier: unknown): string {
  const text = typeof tier === "string" ? tier : "";
  return resolveTier(text)?.key ?? text.trim().toLowerCase();
}

function reviewedValueMatches(
  reviewType: SocialReviewType,
  decision: any,
  entry: any,
): boolean {
  return reviewType === "ownership"
    ? handleIdentity(decision?.decidedHandle) === handleIdentity(entry?.handle)
    : tierIdentity(decision?.decidedTier) === tierIdentity(entry?.tier);
}

function decisionSnapshot(decision: any): Record<string, any> {
  const snapshot: Record<string, any> = {};
  for (const key of [
    "status",
    "method",
    "decidedHandle",
    "decidedTier",
    "decidedAt",
    "decidedById",
    "decidedByName",
    "decidedByRole",
    "note",
  ]) {
    if (decision?.[key] !== undefined) snapshot[key] = decision[key];
  }
  return snapshot;
}

/**
 * The decision as it applies to the account right now. A verified/rejected
 * decision whose snapshot no longer matches the current handle/tier is reported
 * as pending — even if the write-time reset (reconcile) never ran.
 */
export function effectiveDecision(
  reviewType: SocialReviewType,
  decision: any,
  entry: any,
): SocialDecisionView {
  if (!decision || !decision.status) return { status: "pending" };
  const plain = decisionSnapshot(decision);
  for (const key of ["invalidatedAt", "invalidatedReason", "lastDecision"]) {
    if (decision[key] !== undefined) plain[key] = decision[key];
  }
  if (
    (DECIDED_STATUSES as readonly string[]).includes(decision.status) &&
    !reviewedValueMatches(reviewType, decision, entry)
  ) {
    return {
      status: "pending",
      stale: true,
      lastDecision: decisionSnapshot(decision),
    };
  }
  return plain as SocialDecisionView;
}

function plain(entry: any): Record<string, any> {
  if (!entry || typeof entry !== "object") return {};
  return typeof entry.toObject === "function" ? entry.toObject() : entry;
}

@Injectable()
export class SocialAccountVerificationService {
  private readonly logger = new Logger(SocialAccountVerificationService.name);

  constructor(
    @InjectModel("SocialAccountVerification")
    private readonly stateModel: Model<any>,
    @InjectModel("SocialAccountReview")
    private readonly reviewModel: Model<any>,
    @InjectModel("User") private readonly userModel: Model<any>,
  ) {}

  /** Records an explicit admin decision for ONE social account. */
  async decide(
    actor: any,
    params: {
      profileType: SocialProfileType;
      profileId: string;
      entry: any;
      reviewType: SocialReviewType;
      body: SocialDecisionBody;
    },
  ) {
    const role = String(actor?.role || "").toLowerCase();
    if (!ADMIN_ROLES.includes(role)) {
      throw new ForbiddenException("Admin access only");
    }
    const { profileType, profileId, reviewType, body } = params;
    const entry = plain(params.entry);
    const socialAccountId: unknown = entry.socialAccountId;
    if (!isSocialAccountId(socialAccountId)) {
      throw new BadRequestException("Invalid social account id");
    }

    const status = body?.status;
    if (
      typeof status !== "string" ||
      !(DECIDED_STATUSES as readonly string[]).includes(status)
    ) {
      throw new BadRequestException('status must be "verified" or "rejected"');
    }
    if (
      body.note !== undefined &&
      body.note !== null &&
      typeof body.note !== "string"
    ) {
      throw new BadRequestException("note must be text");
    }
    const note = typeof body.note === "string" ? body.note.trim() : "";
    if (note.length > NOTE_MAX_LENGTH) {
      throw new BadRequestException(
        `note must be at most ${NOTE_MAX_LENGTH} characters`,
      );
    }

    // Refuse to record a decision about a value the admin never saw.
    if (reviewType === "ownership" && body.expectedHandle !== undefined) {
      if (
        handleIdentity(body.expectedHandle) !== handleIdentity(entry.handle)
      ) {
        throw new ConflictException(
          "This account's handle has changed since you loaded it. Refresh and review it again.",
        );
      }
    }
    if (reviewType === "tier" && body.expectedTier !== undefined) {
      if (tierIdentity(body.expectedTier) !== tierIdentity(entry.tier)) {
        throw new ConflictException(
          "This account's declared tier has changed since you loaded it. Refresh and review it again.",
        );
      }
    }

    const decidedById = String(actor?.userId || actor?.id || "");
    const decidedByName = await this.adminName(decidedById, actor);
    const now = new Date();
    const filter = { profileType, profileId, socialAccountId };

    const existing = await this.stateModel.findOne(filter).lean();
    const previousStatus = effectiveDecision(
      reviewType,
      (existing as any)?.[reviewType],
      entry,
    ).status;

    // Every decided* field comes from the server: the current account state and the token.
    const decision: Record<string, any> = {
      status,
      method: "manual",
      decidedAt: now,
      decidedById,
      decidedByName,
      decidedByRole: role,
      note,
    };
    if (reviewType === "ownership")
      decision.decidedHandle = String(entry.handle ?? "");
    else decision.decidedTier = String(entry.tier ?? "");

    const platformKey = String(
      entry.platformKey || derivePlatformKey(entry.platform),
    );
    const state = await this.stateModel
      .findOneAndUpdate(
        filter,
        { $set: { platformKey, [reviewType]: decision } },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      )
      .lean();

    await this.reviewModel.create({
      socialAccountId,
      profileId,
      profileType,
      platformKey,
      platform: String(entry.platform ?? ""),
      handle: String(entry.handle ?? ""),
      declaredTier: String(entry.tier ?? ""),
      reviewType,
      previousStatus,
      newStatus: status,
      method: "manual",
      decidedAt: now,
      decidedById,
      decidedByName,
      decidedByRole: role,
      note,
    });

    return this.view(entry, state);
  }

  /** Effective ownership/tier status for every social account on a profile (admin view). */
  async listForProfile(
    profileType: SocialProfileType,
    profileId: string,
    socialMedia: any[] | null | undefined,
  ) {
    const entries = (Array.isArray(socialMedia) ? socialMedia : []).map(plain);
    const states: any[] = await this.stateModel
      .find({ profileType, profileId })
      .lean();
    const byId = new Map(states.map((s) => [String(s.socialAccountId), s]));
    return entries.map((entry) =>
      this.view(
        entry,
        isSocialAccountId(entry.socialAccountId)
          ? byId.get(entry.socialAccountId)
          : undefined,
      ),
    );
  }

  /**
   * Called after ANY save that may have changed socialMedia (creator or admin
   * edit). Resets a verified/rejected decision to pending when the account's
   * handle (ownership) or declared tier (tier) no longer matches what was
   * reviewed, keeping the old decision as lastDecision and logging a history
   * row. Never verifies anything. Failures are logged, not thrown — the profile
   * is already saved, and effectiveDecision() still reports the stale decision
   * as pending.
   */
  async reconcile(
    profileType: SocialProfileType,
    profileId: string,
    socialMedia: any[] | null | undefined,
  ): Promise<number> {
    try {
      const entries = (Array.isArray(socialMedia) ? socialMedia : []).map(
        plain,
      );
      const byId = new Map(
        entries
          .filter((e) => isSocialAccountId(e.socialAccountId))
          .map((e) => [e.socialAccountId as string, e]),
      );
      if (!byId.size) return 0;
      const states: any[] = await this.stateModel
        .find({
          profileType,
          profileId,
          socialAccountId: { $in: [...byId.keys()] },
        })
        .lean();

      let invalidated = 0;
      for (const state of states) {
        const entry = byId.get(String(state.socialAccountId));
        for (const reviewType of ["ownership", "tier"] as SocialReviewType[]) {
          const decision = state[reviewType];
          if (
            !decision ||
            !(DECIDED_STATUSES as readonly string[]).includes(
              decision.status,
            ) ||
            reviewedValueMatches(reviewType, decision, entry)
          ) {
            continue;
          }
          const now = new Date();
          const reason =
            reviewType === "ownership" ? "handle_changed" : "tier_changed";
          // Guarded on the decision we read, so a newer admin decision is never overwritten.
          const res = await this.stateModel.updateOne(
            {
              _id: state._id,
              [`${reviewType}.status`]: decision.status,
              [`${reviewType}.decidedAt`]: decision.decidedAt,
            },
            {
              $set: {
                [reviewType]: {
                  status: "pending",
                  note: "",
                  invalidatedAt: now,
                  invalidatedReason: reason,
                  lastDecision: decisionSnapshot(decision),
                },
              },
            },
          );
          if (!res?.modifiedCount) continue;
          invalidated++;
          await this.reviewModel.create({
            socialAccountId: state.socialAccountId,
            profileId,
            profileType,
            platformKey: String(entry?.platformKey || state.platformKey || ""),
            platform: String(entry?.platform ?? ""),
            handle: String(entry?.handle ?? ""),
            declaredTier: String(entry?.tier ?? ""),
            reviewType,
            previousStatus: decision.status,
            newStatus: "pending",
            method: "invalidated",
            decidedAt: now,
            decidedById: "SYSTEM",
            decidedByName: "System",
            decidedByRole: "system",
            note:
              reviewType === "ownership"
                ? `Handle changed from @${decision.decidedHandle ?? ""} to @${entry?.handle ?? ""}`
                : `Declared tier changed from ${decision.decidedTier ?? ""} to ${entry?.tier ?? ""}`,
          });
        }
      }
      return invalidated;
    } catch (err) {
      this.logger.error(
        `Social verification reconcile failed for ${profileType} ${profileId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return 0;
    }
  }

  private view(entry: any, state: any) {
    return {
      socialAccountId: isSocialAccountId(entry?.socialAccountId)
        ? entry.socialAccountId
        : null,
      platform: String(entry?.platform ?? ""),
      handle: String(entry?.handle ?? ""),
      tier: String(entry?.tier ?? ""),
      ownershipVerification: effectiveDecision(
        "ownership",
        state?.ownership,
        entry,
      ),
      tierVerification: effectiveDecision("tier", state?.tier, entry),
    };
  }

  /** Admin display name from the users collection (the JWT carries only id/email/role). */
  private async adminName(adminId: string, actor: any): Promise<string> {
    try {
      const admin: any = adminId
        ? await this.userModel.findById(adminId).select("name email").lean()
        : null;
      return String(admin?.name || admin?.email || actor?.email || "");
    } catch {
      return String(actor?.email || "");
    }
  }
}
