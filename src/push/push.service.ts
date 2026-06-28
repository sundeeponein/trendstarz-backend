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
    @InjectModel("NotificationPreference")
    private readonly preferenceModel: Model<any>,
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
    deviceType: "web" | "mobile" = "web",
  ) {
    await this.subModel.findOneAndUpdate(
      { endpoint: subscription.endpoint },
      { userId, userRole, deviceType, ...subscription },
      { upsert: true, new: true },
    );
    return { success: true };
  }

  async unsubscribe(endpoint: string) {
    await this.subModel.deleteOne({ endpoint });
    return { success: true };
  }

  /** Account-level preference for whether push is sent, split by device and event category. */
  async getPreferences(userId: string) {
    const pref: any = await this.preferenceModel.findOne({ userId }).lean();
    return {
      webEnabled: pref?.webEnabled ?? true,
      mobileEnabled: pref?.mobileEnabled ?? true,
      campaignEnabled: pref?.campaignEnabled ?? true,
      paymentEnabled: pref?.paymentEnabled ?? true,
    };
  }

  async setPreferences(
    userId: string,
    updates: {
      webEnabled?: boolean;
      mobileEnabled?: boolean;
      campaignEnabled?: boolean;
      paymentEnabled?: boolean;
    },
  ) {
    const $set: Record<string, boolean> = {};
    for (const key of ["webEnabled", "mobileEnabled", "campaignEnabled", "paymentEnabled"] as const) {
      if (typeof updates[key] === "boolean") $set[key] = updates[key] as boolean;
    }
    const pref = await this.preferenceModel.findOneAndUpdate(
      { userId },
      { $set },
      { upsert: true, new: true },
    );
    return {
      webEnabled: pref.webEnabled ?? true,
      mobileEnabled: pref.mobileEnabled ?? true,
      campaignEnabled: pref.campaignEnabled ?? true,
      paymentEnabled: pref.paymentEnabled ?? true,
    };
  }

  /** Send a push notification to all subscriptions for a given userId. */
  async sendToUser(
    userId: string,
    payload: { title: string; body: string; icon?: string; url?: string },
    category: "campaign" | "payment",
  ) {
    if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
      return { sent: 0, failed: 0 };
    }
    const prefs = await this.getPreferences(userId);
    const categoryAllowed =
      category === "payment" ? prefs.paymentEnabled : prefs.campaignEnabled;
    if (!categoryAllowed) {
      return { sent: 0, failed: 0 };
    }
    // Angular's service worker only calls showNotification() when the push
    // payload has a top-level "notification" key (see ngsw-worker.js
    // handlePush). The click target URL must live under
    // notification.data.onActionClick.default.url.
    const swPayload = JSON.stringify({
      notification: {
        title: payload.title,
        body: payload.body,
        icon: payload.icon,
        data: payload.url
          ? { onActionClick: { default: { url: payload.url } } }
          : undefined,
      },
    });
    const subs = await this.subModel.find({ userId }).lean();
    const allowedSubs = subs.filter((sub: any) =>
      sub.deviceType === "mobile" ? prefs.mobileEnabled : prefs.webEnabled,
    );
    const results = await Promise.allSettled(
      allowedSubs.map((sub: any) =>
        webpush
          .sendNotification(
            { endpoint: sub.endpoint, keys: sub.keys },
            swPayload,
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
