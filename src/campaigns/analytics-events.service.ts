import { Injectable, Logger } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";

type IncomingAnalyticsEvent = {
  eventType?: string;
  timestamp?: string | Date;
  userId?: string;
  userRole?: string;
  metadata?: Record<string, unknown>;
};

@Injectable()
export class AnalyticsEventsService {
  private readonly logger = new Logger(AnalyticsEventsService.name);
  private readonly allowedEventTypes = new Set([
    "campaign_invite_sent",
    "campaign_completed",
  ]);

  constructor(
    @InjectModel("AnalyticsEvent")
    private readonly analyticsEventModel: Model<any>,
  ) {}

  async ingestEvents(payload: { events?: IncomingAnalyticsEvent[] }) {
    const rows = Array.isArray(payload?.events) ? payload.events : [];
    if (!rows.length) {
      return { accepted: 0, dropped: 0 };
    }

    const docs = rows
      .map((row) => this.normalizeEvent(row))
      .filter((row) => !!row);

    if (!docs.length) {
      return { accepted: 0, dropped: rows.length };
    }

    const dedupeQuery = this.buildCampaignCompletionDedupeQuery(docs);
    if (dedupeQuery.length > 0) {
      const existing = await this.analyticsEventModel
        .find({ $or: dedupeQuery })
        .select("eventType metadata")
        .lean();

      const existingKeys = new Set(
        (existing || [])
          .map((event: any) => this.getCompletionDedupeKey(event))
          .filter((key: string | null) => !!key),
      );

      const filtered = docs.filter((doc: any) => {
        const key = this.getCompletionDedupeKey(doc);
        if (!key) return true;
        return !existingKeys.has(key);
      });

      if (!filtered.length) {
        return { accepted: 0, dropped: rows.length };
      }

      docs.length = 0;
      docs.push(...filtered);
    }

    await this.analyticsEventModel.insertMany(docs, { ordered: false });
    const dropped = rows.length - docs.length;
    if (dropped > 0) {
      this.logger.warn(`Dropped ${dropped} analytics events due to invalid payload.`);
    }
    return { accepted: docs.length, dropped };
  }

  private normalizeEvent(row: IncomingAnalyticsEvent | null | undefined) {
    if (!row?.eventType || !this.allowedEventTypes.has(String(row.eventType))) {
      return null;
    }

    const parsedTimestamp = row.timestamp ? new Date(row.timestamp) : new Date();
    const timestamp = Number.isNaN(parsedTimestamp.getTime())
      ? new Date()
      : parsedTimestamp;

    return {
      eventType: String(row.eventType),
      timestamp,
      userId: row.userId ? String(row.userId) : undefined,
      userRole: row.userRole ? String(row.userRole) : undefined,
      metadata:
        row.metadata && typeof row.metadata === "object" ? row.metadata : {},
      receivedAt: new Date(),
    };
  }

  private getCompletionDedupeKey(event: any): string | null {
    const eventType = String(event?.eventType || "");
    const stage = String(event?.metadata?.completionStage || "");
    const inviteId = String(event?.metadata?.inviteId || "");
    if (eventType !== "campaign_completed" || !stage || !inviteId) return null;
    return `${eventType}:${stage}:${inviteId}`;
  }

  private buildCampaignCompletionDedupeQuery(docs: any[]): any[] {
    return docs
      .map((doc: any) => {
        const stage = String(doc?.metadata?.completionStage || "");
        const inviteId = String(doc?.metadata?.inviteId || "");
        if (String(doc?.eventType || "") !== "campaign_completed" || !stage || !inviteId) {
          return null;
        }
        return {
          eventType: "campaign_completed",
          "metadata.completionStage": stage,
          "metadata.inviteId": inviteId,
        };
      })
      .filter((row: any) => !!row);
  }
}
