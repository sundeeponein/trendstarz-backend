import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { InjectConnection } from "@nestjs/mongoose";
import { Connection, Types } from "mongoose";
import { NotificationsService } from "../notifications/notifications.service";
import { PushService } from "../push/push.service";
import { PriceChange, rateKey } from "./price-changes.util";

/** One document per price change. See price-changes.util for the rules. */
export const PRICE_CHANGES = "price_changes";

export type CreatorRole = "influencer" | "photographer";

/**
 * applied  — an ordinary change, live at once
 * pending  — a big jump waiting for admin approval (brands see oldPrice)
 * approved / rejected — an admin decided a pending one
 * replaced — a pending one the creator changed again before review
 */
export type PriceChangeStatus =
  | "applied"
  | "pending"
  | "approved"
  | "rejected"
  | "replaced";

const COLLECTION: Record<CreatorRole, string> = {
  influencer: "influencers",
  photographer: "photographers",
};
const PROFILE_URL: Record<CreatorRole, string> = {
  influencer: "/influencer-profile",
  photographer: "/photographer-profile",
};

function rupees(value: unknown): string {
  return `₹${Number(value || 0).toLocaleString("en-IN")}`;
}

function rateLabel(doc: { platform?: string; rateName?: string }): string {
  return [doc.platform, doc.rateName].filter(Boolean).join(" ");
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

@Injectable()
export class PriceChangesService {
  private readonly logger = new Logger(PriceChangesService.name);
  private indexReady: Promise<unknown> | null = null;

  constructor(
    @InjectConnection() private readonly connection: Connection,
    private readonly notifications: NotificationsService,
    private readonly push: PushService,
  ) {}

  private col() {
    const col = this.connection.collection(PRICE_CHANGES);
    this.indexReady ??= Promise.all([
      col.createIndex({ userId: 1, createdAt: -1 }),
      col.createIndex({ status: 1, createdAt: -1 }),
      // At most one waiting price per rate.
      col.createIndex(
        { userId: 1, source: 1, socialAccountId: 1, rateKey: 1 },
        { unique: true, partialFilterExpression: { status: "pending" } },
      ),
    ]).catch(() => (this.indexReady = null));
    return col;
  }

  private sameRate(userId: string, c: PriceChange) {
    return {
      userId,
      source: c.source,
      socialAccountId: c.socialAccountId,
      rateKey: rateKey(c.rateName),
    };
  }

  /**
   * Called after a creator's profile save went through. Best effort: a failure
   * here is logged and never undoes the save.
   */
  async record(
    userId: string,
    role: CreatorRole,
    applied: PriceChange[],
    held: PriceChange[],
  ): Promise<void> {
    if (!applied.length && !held.length) return;
    const col = this.col();
    const now = new Date();
    const newlyWaiting: PriceChange[] = [];
    try {
      for (const c of applied) {
        // The creator set another (ordinary) price: a waiting one is no longer wanted.
        await col.updateMany(
          { ...this.sameRate(userId, c), status: "pending" },
          { $set: { status: "replaced", reviewedAt: now } },
        );
        await col.insertOne({
          ...this.sameRate(userId, c),
          role,
          platform: c.platform,
          rateName: c.rateName,
          oldPrice: c.oldPrice,
          newPrice: c.newPrice,
          status: "applied",
          createdAt: now,
        });
      }
      for (const c of held) {
        const waiting: any = await col.findOne({
          ...this.sameRate(userId, c),
          status: "pending",
        });
        // Re-saving the profile sends the same raise again: nothing new.
        if (
          waiting &&
          Number(waiting.newPrice) === c.newPrice &&
          Number(waiting.oldPrice) === c.oldPrice
        ) {
          continue;
        }
        if (waiting) {
          await col.updateOne(
            { _id: waiting._id, status: "pending" },
            { $set: { status: "replaced", reviewedAt: now } },
          );
        }
        try {
          await col.insertOne({
            ...this.sameRate(userId, c),
            role,
            platform: c.platform,
            rateName: c.rateName,
            oldPrice: c.oldPrice,
            newPrice: c.newPrice,
            status: "pending",
            createdAt: now,
          });
          newlyWaiting.push(c);
        } catch (e: any) {
          if (e?.code !== 11000) throw e; // two saves at once: one pending is kept
        }
      }
    } catch (e) {
      this.logger.error(`Could not record price changes for ${userId}: ${String(e)}`);
    }
    if (newlyWaiting.length) {
      const list = newlyWaiting
        .map((c) => `${rateLabel(c)} ${rupees(c.oldPrice)} → ${rupees(c.newPrice)}`)
        .join(", ");
      const message = {
        title: "New price waiting for approval",
        body: `Prices that double or more are checked by our team first: ${list}. Brands see your current price until it's approved.`,
        url: PROFILE_URL[role],
      };
      this.notifications
        .createForUser({ userId, userRole: role, ...message })
        .catch(() => undefined);
    }
  }

  /** Admin: a creator's price history, newest first. */
  async listForUser(userId: string, limit = 50) {
    const rows = await this.col()
      .find({ userId: String(userId) })
      .sort({ createdAt: -1 })
      .limit(Math.min(Math.max(Number(limit) || 50, 1), 200))
      .toArray();
    return rows.map((r: any) => ({ ...r, _id: String(r._id) }));
  }

  /** Creator: their own prices waiting for approval. */
  async pendingForUser(userId: string) {
    const rows = await this.col()
      .find({ userId: String(userId), status: "pending" })
      .sort({ createdAt: -1 })
      .project({
        source: 1,
        socialAccountId: 1,
        platform: 1,
        rateName: 1,
        oldPrice: 1,
        newPrice: 1,
        createdAt: 1,
      })
      .toArray();
    return rows.map((r: any) => ({ ...r, _id: String(r._id) }));
  }

  /**
   * Admin list signals for the given profiles: last price change (any status)
   * and how many prices wait for approval.
   */
  async signalsFor(
    ids: string[],
  ): Promise<Map<string, { lastPriceChangeAt: Date | null; pricePendingCount: number }>> {
    const out = new Map<string, { lastPriceChangeAt: Date | null; pricePendingCount: number }>();
    if (!ids.length) return out;
    const rows = await this.col()
      .aggregate([
        { $match: { userId: { $in: ids } } },
        {
          $group: {
            _id: "$userId",
            last: { $max: "$createdAt" },
            pending: { $sum: { $cond: [{ $eq: ["$status", "pending"] }, 1, 0] } },
          },
        },
      ])
      .toArray();
    for (const r of rows) {
      out.set(String(r._id), {
        lastPriceChangeAt: r.last ?? null,
        pricePendingCount: Number(r.pending || 0),
      });
    }
    return out;
  }

  /** Admin: apply a waiting price. */
  async approve(id: string, adminId: string) {
    const doc = await this.claim(id, "approved", adminId, "");
    const now = new Date();
    const userId = String(doc.userId);
    const nameMatch = { $regex: `^\\s*${escapeRegex(String(doc.rateName))}\\s*$`, $options: "i" };
    let result;
    // Only if the profile still shows the price the raise was made from.
    if (doc.source === "social") {
      result = await this.connection.collection(COLLECTION[doc.role as CreatorRole]).updateOne(
        { _id: new Types.ObjectId(userId) },
        {
          $set: {
            "socialMedia.$[a].contentTypes.$[r].price": doc.newPrice,
            "socialMedia.$[a].contentTypes.$[r].priceConfirmedAt": now,
          },
        },
        {
          arrayFilters: [
            { "a.socialAccountId": doc.socialAccountId },
            { "r.name": nameMatch, "r.price": doc.oldPrice },
          ],
        },
      );
    } else {
      result = await this.connection.collection(COLLECTION.photographer).updateOne(
        { _id: new Types.ObjectId(userId) },
        { $set: { "pricing.$[r].price": doc.newPrice } },
        { arrayFilters: [{ "r.name": nameMatch, "r.price": doc.oldPrice }] },
      );
    }
    if (!result.modifiedCount) {
      await this.col().updateOne(
        { _id: doc._id },
        { $set: { status: "replaced", reviewedAt: now } },
      );
      throw new ConflictException(
        "This rate changed or was removed since — nothing was applied.",
      );
    }
    this.tell(doc, {
      title: "New price approved",
      body: `Your ${rateLabel(doc)} price is now ${rupees(doc.newPrice)}.`,
    });
    return { status: "approved" };
  }

  /** Admin: keep the current price. */
  async reject(id: string, adminId: string, note?: string) {
    const reason = String(note ?? "").trim().slice(0, 300);
    const doc = await this.claim(id, "rejected", adminId, reason);
    this.tell(doc, {
      title: "New price not approved",
      body: `Your ${rateLabel(doc)} price stays ${rupees(doc.oldPrice)} (requested ${rupees(doc.newPrice)}).${reason ? ` Note: ${reason}` : ""}`,
    });
    return { status: "rejected" };
  }

  /** Moves a pending change to its decision; only one admin action wins. */
  private async claim(id: string, status: "approved" | "rejected", adminId: string, note: string) {
    if (!Types.ObjectId.isValid(id)) throw new BadRequestException("Invalid id");
    const doc: any = await this.col().findOneAndUpdate(
      { _id: new Types.ObjectId(id), status: "pending" },
      {
        $set: {
          status,
          reviewedAt: new Date(),
          reviewedBy: String(adminId || ""),
          adminNote: note,
        },
      },
      { returnDocument: "after" },
    );
    const found = doc?.value !== undefined ? doc.value : doc;
    if (!found) {
      const exists = await this.col().findOne({ _id: new Types.ObjectId(id) });
      if (!exists) throw new NotFoundException("Price change not found");
      throw new ConflictException("This price change was already handled.");
    }
    return found;
  }

  private tell(doc: any, message: { title: string; body: string }) {
    const role = doc.role as CreatorRole;
    const full = { ...message, url: PROFILE_URL[role] };
    this.notifications
      .createForUser({ userId: String(doc.userId), userRole: role, ...full })
      .catch(() => undefined);
    this.push.sendToUser(String(doc.userId), full, "campaign").catch(() => undefined);
  }
}
