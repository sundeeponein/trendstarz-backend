import { Injectable } from '@nestjs/common';
import { InfluencerModel, BrandModel } from '../database/schemas/profile.schemas';

@Injectable()
export class PaymentService {
  async createPayment(userId: string, amount: number, method: string) {
    // Simulate payment success
    // In production, integrate with payment gateway here
    // After payment, set user as premium
    let user = await InfluencerModel.findByIdAndUpdate(userId, { isPremium: true }, { new: true });
    if (!user) {
      user = await BrandModel.findByIdAndUpdate(userId, { isPremium: true }, { new: true });
    }
    if (user) {
      return { success: true, message: 'Payment successful, user upgraded to premium', user };
    }
    return { success: false, message: 'User not found' };
  }
}
