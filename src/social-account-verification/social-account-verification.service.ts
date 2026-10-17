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
  SOCIAL_EVIDENCE_BASES,
  SocialProfileType,
  SocialReviewType,
  SocialVerificationStatus,
} from "../database/schemas/social-account-verification.schema";
import {
  derivePlatformKey,
  isSocialAccountId,
  socialHandleKey,
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
  /** Stage 3D-1b: "observed" | "manual_check" (optional). */
  evidenceBasis?: unknown;
}

export interface SocialDecisionView {
  status: SocialVerificationStatus;
  method?: string;
  evidenceBasis?: string;
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
    "evidenceBasis",
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

/** Admin view of a broken-link report (no reporter ids). */
function linkReportView(report: any) {
  if (!report?.status) return null;
  return {
    status: report.status,
    handle: report.handle || "",
    count: Number(report.count || 0),
    firstReportedAt: report.firstReportedAt || null,
    lastReportedAt: report.lastReportedAt || null,
    resolvedAt: report.resolvedAt || null,
    resolvedByName: report.resolvedByName || "",
    note: report.note || "",
  };
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
    const evidenceBasis = body.evidenceBasis ?? undefined;
    if (
      evidenceBasis !== undefined &&
      !(SOCIAL_EVIDENCE_BASES as readonly unknown[]).includes(evidenceBasis)
    ) {
      throw new BadRequestException(
        'evidenceBasis must be "observed" or "manual_check"',
      );
    }
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
      ...(evidenceBasis ? { evidenceBasis } : {}),
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
      ...(evidenceBasis ? { evidenceBasis } : {}),
      decidedAt: now,
      decidedById,
      decidedByName,
      decidedByRole: role,
      note,
    });

    return this.view(entry, state);
  }

  /**
   * Records an automatic tier verification (after the system moved the declared
   * tier to the observed one). Not an admin action: method "auto", evidence
   * "observed", and the account is marked so it is never auto-corrected again.
   * Call after the profile save + reconcile, with the updated entry.
   */
  async recordAutomaticTierDecision(params: {
    profileType: SocialProfileType;
    profileId: string;
    entry: any;
    decidedByName: string;
    note: string;
    now?: Date;
    /** false = only verified a tier that already matched (not a correction). */
    markAutoApplied?: boolean;
  }) {
    const entry = plain(params.entry);
    const socialAccountId: unknown = entry.socialAccountId;
    if (!isSocialAccountId(socialAccountId)) {
      throw new BadRequestException("Invalid social account id");
    }
    const now = params.now ?? new Date();
    const { profileType, profileId } = params;
    const filter = { profileType, profileId, socialAccountId };
    const existing = await this.stateModel.findOne(filter).lean();
    const previousStatus = effectiveDecision(
      "tier",
      (existing as any)?.tier,
      entry,
    ).status;
    const decision = {
      status: "verified",
      method: "auto",
      evidenceBasis: "observed",
      decidedTier: String(entry.tier ?? ""),
      decidedAt: now,
      decidedById: "system",
      decidedByName: params.decidedByName,
      decidedByRole: "system",
      note: params.note,
    };
    const platformKey = String(
      entry.platformKey || derivePlatformKey(entry.platform),
    );
    await this.stateModel.findOneAndUpdate(
      filter,
      {
        $set: {
          platformKey,
          tier: decision,
          ...(params.markAutoApplied === false
            ? {}
            : { tierAutoAppliedAt: now }),
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    await this.reviewModel.create({
      socialAccountId,
      profileId,
      profileType,
      platformKey,
      platform: String(entry.platform ?? ""),
      handle: String(entry.handle ?? ""),
      declaredTier: String(entry.tier ?? ""),
      reviewType: "tier",
      previousStatus,
      newStatus: "verified",
      method: "auto",
      evidenceBasis: "observed",
      decidedAt: now,
      decidedById: "system",
      decidedByName: params.decidedByName,
      decidedByRole: "system",
      note: params.note,
    });
  }

  /**
   * Profiles that have at least one ownership/tier review reset to pending by
   * a handle/tier change (and not re-decided since). Read-only; used by the
   * admin "Social media changed" filter and row badge.
   */
  async profileIdsWithChangedReviews(
    profileType: SocialProfileType,
    profileIds?: string[],
  ): Promise<Set<string>> {
    const query: Record<string, unknown> = {
      profileType,
      $or: [
        {
          "ownership.status": "pending",
          "ownership.invalidatedAt": { $ne: null },
        },
        { "tier.status": "pending", "tier.invalidatedAt": { $ne: null } },
        // Hosts reported the link doesn't open — waiting for admin to confirm/dismiss.
        { "linkReport.status": "open" },
      ],
    };
    if (profileIds) {
      if (!profileIds.length) return new Set();
      query.profileId = { $in: profileIds };
    }
    const rows = (await this.stateModel
      .find(query)
      .select("profileId")
      .lean()) as Array<{
      profileId?: unknown;
    }>;
    return new Set(rows.map((r) => String(r.profileId)));
  }

  /** Profiles with an OPEN broken-link report (admin "Link not working — reported" filter). */
  async profileIdsWithOpenLinkReports(
    profileType: SocialProfileType,
    profileIds?: string[],
  ): Promise<Set<string>> {
    const query: Record<string, unknown> = {
      profileType,
      "linkReport.status": "open",
    };
    if (profileIds) {
      if (!profileIds.length) return new Set();
      query.profileId = { $in: profileIds };
    }
    const rows = (await this.stateModel
      .find(query)
      .select("profileId")
      .lean()) as Array<{ profileId?: unknown }>;
    return new Set(rows.map((r) => String(r.profileId)));
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
        // The creator updated the handle a broken-link report was about: report closed.
        const report = state.linkReport;
        if (
          (report?.status === "open" || report?.status === "confirmed") &&
          socialHandleKey(report.handle) !== socialHandleKey(entry?.handle)
        ) {
          await this.stateModel.updateOne(
            { _id: state._id, "linkReport.status": report.status },
            {
              $set: {
                "linkReport.status": "resolved",
                "linkReport.resolvedAt": new Date(),
                "linkReport.resolvedByName": "Creator updated the handle",
              },
            },
          );
        }
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
      linkReport: linkReportView(state?.linkReport),
    };
  }

  // ── Broken-link reports (hosts) ─────────────────────────────────────────────

  /** A REPORTER_COOLDOWN_DAYS window per reporter per account. */
  static readonly REPORTER_COOLDOWN_DAYS = 30;

  /**
   * A signed-in user reports that a social account's link doesn't open. Returns
   * `firstOpen: true` when this report opened the case (the caller tells the creator).
   */
  async reportBrokenLink(params: {
    profileType: SocialProfileType;
    profileId: string;
    entry: any;
    reporterId: string;
    reporterRole: string;
    now?: Date;
  }): Promise<{ firstOpen: boolean; status: string }> {
    const now = params.now || new Date();
    const entry = plain(params.entry);
    const socialAccountId = String(entry.socialAccountId || "");
    if (!isSocialAccountId(socialAccountId)) {
      throw new BadRequestException("Unknown social account");
    }
    const filter = {
      profileType: params.profileType,
      profileId: params.profileId,
      socialAccountId,
    };
    const state: any = await this.stateModel.findOne(filter).lean();
    const report = state?.linkReport;
    const sameHandle =
      socialHandleKey(report?.handle) === socialHandleKey(entry.handle);
    const isOpen = report?.status === "open" && sameHandle;
    if (isOpen) {
      const cutoff =
        now.getTime() -
        SocialAccountVerificationService.REPORTER_COOLDOWN_DAYS * 86400000;
      const recent = (report.reporters || []).some(
        (r: any) =>
          String(r.userId) === String(params.reporterId) &&
          new Date(r.at).getTime() > cutoff,
      );
      if (recent) return { firstOpen: false, status: "open" };
      await this.stateModel.updateOne(filter, {
        $set: { "linkReport.lastReportedAt": now },
        $inc: { "linkReport.count": 1 },
        $push: {
          "linkReport.reporters": {
            userId: String(params.reporterId),
            role: params.reporterRole,
            at: now,
          },
        },
      });
      return { firstOpen: false, status: "open" };
    }
    await this.stateModel.updateOne(
      filter,
      {
        $setOnInsert: {
          platformKey: String(
            entry.platformKey || derivePlatformKey(entry.platform),
          ),
        },
        $set: {
          linkReport: {
            status: "open",
            handle: String(entry.handle || ""),
            firstReportedAt: now,
            lastReportedAt: now,
            count: 1,
            reporters: [
              {
                userId: String(params.reporterId),
                role: params.reporterRole,
                at: now,
              },
            ],
          },
        },
      },
      { upsert: true },
    );
    return { firstOpen: true, status: "open" };
  }

  /**
   * Admin decides a broken-link report. confirm → the ownership decision goes back to
   * pending (reason link_broken), so the account is re-reviewed in "Social changed";
   * dismiss → the link works, report closed.
   */
  async resolveLinkReport(
    actor: any,
    params: {
      profileType: SocialProfileType;
      profileId: string;
      entry: any;
      action: "confirm" | "dismiss";
      note?: string;
    },
  ): Promise<{ status: string }> {
    const entry = plain(params.entry);
    const filter = {
      profileType: params.profileType,
      profileId: params.profileId,
      socialAccountId: String(entry.socialAccountId || ""),
    };
    const state: any = await this.stateModel.findOne(filter).lean();
    if (state?.linkReport?.status !== "open") {
      throw new ConflictException(
        "There is no open link report on this account.",
      );
    }
    const now = new Date();
    const adminId = String(actor?.userId || actor?._id || actor?.id || "");
    const adminName = await this.adminName(adminId, actor);
    const status = params.action === "confirm" ? "confirmed" : "dismissed";
    const set: Record<string, unknown> = {
      "linkReport.status": status,
      "linkReport.resolvedAt": now,
      "linkReport.resolvedById": adminId,
      "linkReport.resolvedByName": adminName,
      "linkReport.note": String(params.note || "").trim(),
    };
    const ownership = state.ownership;
    const resetOwnership =
      params.action === "confirm" &&
      ownership &&
      (DECIDED_STATUSES as readonly string[]).includes(ownership.status);
    if (resetOwnership) {
      set.ownership = {
        status: "pending",
        note: "",
        invalidatedAt: now,
        invalidatedReason: "link_broken",
        lastDecision: decisionSnapshot(ownership),
      };
    }
    const res = await this.stateModel.updateOne(
      { ...filter, "linkReport.status": "open" },
      { $set: set },
    );
    if (!res?.modifiedCount) {
      throw new ConflictException(
        "This report was decided meanwhile. Reload and try again.",
      );
    }
    if (resetOwnership) {
      await this.reviewModel.create({
        socialAccountId: filter.socialAccountId,
        profileId: params.profileId,
        profileType: params.profileType,
        platformKey: String(entry.platformKey || state.platformKey || ""),
        platform: String(entry.platform ?? ""),
        handle: String(entry.handle ?? ""),
        declaredTier: String(entry.tier ?? ""),
        reviewType: "ownership",
        previousStatus: ownership.status,
        newStatus: "pending",
        method: "invalidated",
        decidedAt: now,
        decidedById: adminId,
        decidedByName: adminName,
        decidedByRole: "admin",
        note: `Link @${entry.handle ?? ""} doesn't open (reported by hosts, confirmed by admin).`,
      });
    }
    return { status };
  }

  /** Public, minimal: which accounts of a profile have an open/confirmed broken-link report. */
  async linkReportsForProfile(
    profileType: SocialProfileType,
    profileId: string,
  ): Promise<Record<string, { status: string; since: Date | null }>> {
    const rows: any[] = await this.stateModel
      .find({
        profileType,
        profileId,
        "linkReport.status": { $in: ["open", "confirmed"] },
      })
      .select("socialAccountId linkReport.status linkReport.firstReportedAt")
      .lean();
    const out: Record<string, { status: string; since: Date | null }> = {};
    for (const r of rows) {
      out[String(r.socialAccountId)] = {
        status: String(r.linkReport?.status),
        since: r.linkReport?.firstReportedAt || null,
      };
    }
    return out;
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
