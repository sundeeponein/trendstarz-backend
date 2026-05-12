import { Injectable, NotFoundException } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";

@Injectable()
export class NotificationsService {
  constructor(
    @InjectModel("Notification")
    private readonly notificationModel: Model<any>,
  ) {}

  async createForUser(data: {
    userId: string;
    userRole: "brand" | "influencer" | "admin";
    title: string;
    body: string;
    url?: string;
  }) {
    return this.notificationModel.create({
      userId: String(data.userId),
      userRole: data.userRole,
      title: data.title,
      body: data.body,
      url: data.url || "",
      read: false,
    });
  }

  async listForUser(userId: string, limit = 20) {
    const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 50);
    return this.notificationModel
      .find({ userId: String(userId) })
      .sort({ createdAt: -1 })
      .limit(safeLimit)
      .lean();
  }

  async unreadCount(userId: string) {
    const count = await this.notificationModel.countDocuments({
      userId: String(userId),
      read: false,
    });
    return { count };
  }

  async markRead(userId: string, notificationId: string) {
    const updated = await this.notificationModel.findOneAndUpdate(
      { _id: notificationId, userId: String(userId) },
      { $set: { read: true } },
      { new: true },
    );
    if (!updated) throw new NotFoundException("Notification not found");
    return { success: true };
  }

  async markAllRead(userId: string) {
    await this.notificationModel.updateMany(
      { userId: String(userId), read: false },
      { $set: { read: true } },
    );
    return { success: true };
  }
}
