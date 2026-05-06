import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import * as webpush from "web-push";

@Injectable()
export class PushService implements OnModuleInit {
  private readonly logger = new Logger(PushService.name);

  constructor(
    @InjectModel("PushSubscription")
    private readonly subModel: Model<any>,
  ) {}

  onModuleInit() {
    const publicKey = process.env.VAPID_PUBLIC_KEY;
    const privateKey = process.env.VAPID_PRIVATE_KEY;
    if (!publicKey || !privateKey) {
      this.logger.warn(
        "VAPID keys not set — web push notifications disabled. Add VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY to .env",
      );
      return;
    }
    webpush.setVapidDetails(
      process.env.VAPID_SUBJECT || "mailto:support@trendstarz.in",
      publicKey,
      privateKey,
    );
  }

  async subscribe(
    userId: string,
    userRole: string,
    subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
  ) {
    await this.subModel.findOneAndUpdate(
      { endpoint: subscription.endpoint },
      { userId, userRole, ...subscription },
      { upsert: true, new: true },
    );
    return { success: true };
  }

  async unsubscribe(endpoint: string) {
    await this.subModel.deleteOne({ endpoint });
    return { success: true };
  }

  /** Send a push notification to all subscriptions for a given userId. */
  async sendToUser(
    userId: string,
    payload: { title: string; body: string; icon?: string; url?: string },
  ) {
    if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
      return { sent: 0, failed: 0 };
    }
    const subs = await this.subModel.find({ userId }).lean();
    const results = await Promise.allSettled(
      subs.map((sub: any) =>
        webpush
          .sendNotification(
            { endpoint: sub.endpoint, keys: sub.keys },
            JSON.stringify(payload),
          )
          .catch(async (err: any) => {
            // Subscription gone (410) — clean it up
            if (err.statusCode === 410 || err.statusCode === 404) {
              await this.subModel.deleteOne({ _id: sub._id });
            }
            throw err;
          }),
      ),
    );
    const sent = results.filter((r) => r.status === "fulfilled").length;
    const failed = results.filter((r) => r.status === "rejected").length;
    this.logger.debug(`Push to ${userId}: ${sent} sent, ${failed} failed`);
    return { sent, failed };
  }
}
