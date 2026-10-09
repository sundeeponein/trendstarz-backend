import { Injectable, Logger } from "@nestjs/common";
import { InjectConnection } from "@nestjs/mongoose";
import { Cron } from "@nestjs/schedule";
import { Connection } from "mongoose";
import { NotificationsService } from "../notifications/notifications.service";
import { PushService } from "../push/push.service";
import { notAvailableEndsAt } from "../utils/collaboration-availability.util";

/** Creator collections whose "not available" periods end (role → collection, profile page). */
const CREATOR_COLLECTIONS = [
  { role: "influencer", collection: "influencers", url: "/influencer-profile" },
  {
    role: "photographer",
    collection: "photographers",
    url: "/photographer-profile",
  },
] as const;

export const AVAILABILITY_REMINDER = {
  title: "Are you open for collaborations again?",
  body: "Your 'not available' period has ended. Update your availability so brands know whether to invite you.",
};

/** Profiles whose "not available" period has ended by `now` (pure, for the job and tests). */
export function endedNotAvailable(
  docs: Array<{ _id: unknown; collaborationAvailability?: any }>,
  now: Date,
): Array<{ _id: unknown }> {
  return docs.filter((d) => {
    const ends = notAvailableEndsAt(d.collaborationAvailability);
    return !ends || ends.getTime() <= now.getTime();
  });
}

/**
 * Option B (3D-1d): "not available" always ends. Daily, profiles whose period
 * has ended go back to "not set" (never to "available" — the creator decides)
 * and get one reminder (in-app + push). Readers already treat an ended period
 * as not set, so this job only makes it permanent and sends the reminder.
 */
@Injectable()
export class AvailabilityExpiryService {
  private readonly logger = new Logger(AvailabilityExpiryService.name);

  constructor(
    @InjectConnection() private readonly connection: Connection,
    private readonly notifications: NotificationsService,
    private readonly push: PushService,
  ) {}

  @Cron("0 10 * * *", { timeZone: "Asia/Kolkata", name: "availabilityExpiry" })
  async runDaily(): Promise<void> {
    try {
      const reset = await this.resetEnded();
      if (reset)
        this.logger.log(
          `Availability: ${reset} "not available" period(s) ended`,
        );
    } catch (err: any) {
      this.logger.error(`Availability expiry failed: ${err?.message || err}`);
    }
  }

  /** Resets every ended period and reminds each creator once. Returns how many were reset. */
  async resetEnded(now = new Date()): Promise<number> {
    let total = 0;
    for (const { role, collection, url } of CREATOR_COLLECTIONS) {
      const col = this.connection.collection(collection);
      const candidates = await col
        .find(
          {
            "collaborationAvailability.state": "not_available",
            isDeleted: { $ne: true },
          },
          { projection: { _id: 1, collaborationAvailability: 1 } },
        )
        .toArray();
      for (const doc of endedNotAvailable(candidates, now)) {
        // Guarded: a creator who changed it meanwhile is left alone (no reminder).
        const res = await col.updateOne(
          {
            _id: doc._id as any,
            "collaborationAvailability.state": "not_available",
          },
          {
            $set: {
              "collaborationAvailability.state": null,
              "collaborationAvailability.enabled": false,
              "collaborationAvailability.stateUpdatedAt": now,
              "collaborationAvailability.notAvailableUntil": null,
            },
          },
        );
        if (!res.modifiedCount) continue;
        total++;
        const userId = String(doc._id);
        this.notifications
          .createForUser({
            userId,
            userRole: role,
            url,
            ...AVAILABILITY_REMINDER,
          })
          .catch(() => undefined);
        this.push
          .sendToUser(userId, { ...AVAILABILITY_REMINDER, url }, "campaign")
          .catch(() => undefined);
      }
    }
    return total;
  }
}
