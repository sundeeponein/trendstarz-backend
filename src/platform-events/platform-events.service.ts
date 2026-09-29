import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Types } from "mongoose";
import {
  isPlatformEventType,
  PlatformEventActorRole,
  PlatformEventType,
} from "./platform-event-types";

export interface RecordPlatformEventInput {
  eventType: PlatformEventType;
  /** When the business action happened. Defaults to now. */
  timestamp?: Date;
  /** Actor. Accepts an ObjectId, a 24-hex string or a populated doc; anything else is kept in metadata.legacyIds. */
  userId?: unknown;
  userRole?: PlatformEventActorRole | null;
  brandId?: unknown;
  campaignId?: unknown;
  influencerId?: unknown;
  inviteId?: unknown;
  recipientRole?: string | null;
  platform?: string | null;
  metadata?: Record<string, unknown>;
  /** For once-only events — a second record() with the same key is a no-op. */
  dedupeKey?: string;
}

/** A plain string/number reference as trimmed text; "" for anything else (objects, etc.). */
function scalarText(value: unknown): string {
  return typeof value === "string" || typeof value === "number"
    ? String(value).trim()
    : "";
}

const ID_FIELDS = [
  "userId",
  "brandId",
  "campaignId",
  "influencerId",
  "inviteId",
] as const;

/** ObjectId, 24-hex string or populated `{ _id }` → ObjectId; anything else (usernames, "admin", …) → null. */
export function toObjectIdOrNull(value: unknown): Types.ObjectId | null {
  if (value == null) return null;
  if (value instanceof Types.ObjectId) return value;
  // Any other ObjectId implementation (BSON ObjectIds expose `_id` as a getter returning themselves).
  if (typeof (value as any).toHexString === "function") {
    return toObjectIdOrNull((value as any).toHexString());
  }
  if (
    typeof value === "object" &&
    "_id" in (value as any) &&
    (value as any)._id !== value
  ) {
    return toObjectIdOrNull((value as any)._id);
  }
  const raw = scalarText(value);
  return /^[a-fA-F0-9]{24}$/.test(raw) ? new Types.ObjectId(raw) : null;
}

export function normalizePlatform(value: unknown): string | null {
  const p = scalarText(value).toLowerCase();
  if (!p) return null;
  return p === "x" ? "twitter" : p;
}

/**
 * The only writer of PlatformEvents (the authoritative marketplace history —
 * see database/schemas/platform-event.schema.ts). Called by the services that
 * own each business action, after that action has been persisted.
 *
 * Never throws to its caller: a marketplace action that already succeeded must
 * not fail because its history row couldn't be written. Failures are logged
 * with enough detail to reconstruct the event; duplicates (same dedupeKey) are
 * a silent no-op by design.
 */
@Injectable()
export class PlatformEventsService implements OnModuleInit {
  private readonly logger = new Logger(PlatformEventsService.name);

  constructor(
    @InjectModel("PlatformEvent")
    private readonly platformEventModel: Model<any>,
  ) {}

  /**
   * Indexes (incl. the unique dedupeKey index that makes retries/refreshes
   * idempotent) are built by Mongoose's autoIndex at startup. Attaching a
   * handler here means a failed build (missing createIndex permission, a
   * conflicting hand-made index, …) is logged actionably instead of surfacing
   * as an unhandled model 'error' event. Deliberately not awaited: history
   * indexes must never hold up application boot.
   */
  onModuleInit(): void {
    if (typeof this.platformEventModel.init !== "function") return;
    this.platformEventModel.init().catch((err: any) => {
      this.logger.error(
        `platform_events index build failed — dedupe is NOT enforced until fixed ` +
          `(create { dedupeKey: 1 } unique, partialFilterExpression { dedupeKey: { $type: "string" } }): ` +
          `${err?.message || err}`,
        err?.stack,
      );
    });
  }

  /** IDs only (never metadata) — enough to find and replay the event from the source records. */
  private describeRefs(source: Record<string, any>): string {
    const ref = (value: unknown) =>
      toObjectIdOrNull(value)?.toHexString() ?? (scalarText(value) || null);
    return JSON.stringify({
      eventType: scalarText(source?.eventType) || null,
      campaignId: ref(source?.campaignId),
      inviteId: ref(source?.inviteId),
      influencerId: ref(source?.influencerId),
      brandId: ref(source?.brandId),
      userRole: scalarText(source?.userRole) || null,
      dedupeKey: scalarText(source?.dedupeKey) || null,
    });
  }

  /** Validates + normalizes an event into the stored shape. Throws on an unknown event type. */
  buildDocument(input: RecordPlatformEventInput): Record<string, any> {
    if (!isPlatformEventType(input?.eventType)) {
      throw new Error(
        `Unknown platform event type: ${String(input?.eventType)}`,
      );
    }

    const metadata: Record<string, any> = {
      source: "live",
      ...(input.metadata || {}),
    };
    const doc: Record<string, any> = {
      eventType: input.eventType,
      timestamp:
        input.timestamp instanceof Date &&
        !Number.isNaN(input.timestamp.getTime())
          ? input.timestamp
          : new Date(),
      userRole: input.userRole ?? null,
      recipientRole: input.recipientRole
        ? String(input.recipientRole).trim().toLowerCase() === "photographer"
          ? "photographer"
          : "influencer"
        : null,
      platform: normalizePlatform(input.platform),
      metadata,
    };

    const legacyIds: Record<string, string> = {};
    for (const field of ID_FIELDS) {
      const raw = input[field];
      const id = toObjectIdOrNull(raw);
      doc[field] = id;
      const rawText = scalarText(raw);
      if (!id && rawText) legacyIds[field] = rawText;
    }
    if (Object.keys(legacyIds).length) metadata.legacyIds = legacyIds;
    if (input.dedupeKey) doc.dedupeKey = input.dedupeKey;
    return doc;
  }

  /** Records one event. Resolves true if written, false if rejected/duplicate/failed. Never rejects. */
  async record(input: RecordPlatformEventInput): Promise<boolean> {
    let doc: Record<string, any>;
    try {
      doc = this.buildDocument(input);
    } catch (err: any) {
      this.logger.error(
        `Rejected platform event ${this.describeRefs(input)}: ${err?.message || err}`,
      );
      return false;
    }

    try {
      await this.platformEventModel.create(doc);
      return true;
    } catch (err: any) {
      if (err?.code === 11000) return false; // dedupeKey already recorded
      this.logger.error(
        `Failed to record platform event ${this.describeRefs(doc)}: ${err?.message || err}`,
        err?.stack,
      );
      return false;
    }
  }

  /**
   * Records many once-only events (each must carry a dedupeKey), skipping keys
   * already stored. Used for invite_viewed, where the same invite list is
   * loaded on every dashboard refresh. Resolves to the number written.
   */
  async recordOnce(inputs: RecordPlatformEventInput[]): Promise<number> {
    const docs: Record<string, any>[] = [];
    for (const input of inputs || []) {
      if (!input?.dedupeKey) {
        this.logger.error(
          `recordOnce requires a dedupeKey (${String(input?.eventType)})`,
        );
        continue;
      }
      try {
        docs.push(this.buildDocument(input));
      } catch (err: any) {
        this.logger.error(
          `Rejected platform event ${this.describeRefs(input)}: ${err?.message || err}`,
        );
      }
    }
    if (!docs.length) return 0;

    try {
      const existing = await this.platformEventModel
        .find({ dedupeKey: { $in: docs.map((d) => d.dedupeKey) } })
        .select("dedupeKey")
        .lean();
      const seen = new Set((existing || []).map((row: any) => row.dedupeKey));
      const fresh = docs.filter((d) => !seen.has(d.dedupeKey));
      if (!fresh.length) return 0;

      await this.platformEventModel.insertMany(fresh, { ordered: false });
      return fresh.length;
    } catch (err: any) {
      // ordered:false still inserts the non-duplicates; a concurrent request
      // having inserted the same keys first is expected, not an error.
      const writeErrors: any[] = err?.writeErrors || [];
      const onlyDuplicates =
        err?.code === 11000 ||
        (writeErrors.length > 0 &&
          writeErrors.every(
            (e) => e?.code === 11000 || e?.err?.code === 11000,
          ));
      if (!onlyDuplicates) {
        const keys = docs.slice(0, 10).map((d) => d.dedupeKey);
        this.logger.error(
          `Failed to record ${docs.length} platform event(s) (${docs[0]?.eventType}) ` +
            `${JSON.stringify({ dedupeKeys: keys, truncated: docs.length > keys.length })}: ${err?.message || err}`,
          err?.stack,
        );
      }
      return Number(
        err?.insertedDocs?.length || err?.result?.insertedCount || 0,
      );
    }
  }
}
