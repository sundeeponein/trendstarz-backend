import { Injectable } from "@nestjs/common";
import {
  InfluencerModel,
  BrandModel,
} from "../database/schemas/profile.schemas";

@Injectable()
export class PaymentService {
  async confirmUpgrade(
    userId: string,
    premiumDuration: "1m" | "3m" | "1y",
  ) {
    const update: any = { isPremium: true, premiumDuration };
    const now = new Date();
    update.premiumStart = now;
    const end = new Date(now);
    if (premiumDuration === "1m") end.setMonth(end.getMonth() + 1);
    else if (premiumDuration === "3m") end.setMonth(end.getMonth() + 3);
    else if (premiumDuration === "1y") end.setFullYear(end.getFullYear() + 1);
    update.premiumEnd = end;

    const influencer = await InfluencerModel.findByIdAndUpdate(
      userId, update, { new: true },
    );
    if (influencer) return { success: true, message: "Premium activated", premiumEnd: end };
    const brand = await BrandModel.findByIdAndUpdate(
      userId, update, { new: true },
    );
    if (brand) return { success: true, message: "Premium activated", premiumEnd: end };
    return { success: false, message: "User not found" };
  }

  async createPayment(userId: string, amount: number, method: string) {
    // Simulate payment success
    // In production, integrate with payment gateway here
    // After payment, set user as premium
    let user = await InfluencerModel.findByIdAndUpdate(
      userId,
      { isPremium: true },
      { new: true },
    );
    if (!user) {
      user = await BrandModel.findByIdAndUpdate(
        userId,
        { isPremium: true },
        { new: true },
      );
    }
    if (user) {
      return {
        success: true,
        message: "Payment successful, user upgraded to premium",
        user,
      };
    }
    return { success: false, message: "User not found" };
  }
}
