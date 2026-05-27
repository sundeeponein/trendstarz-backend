import { Schema, Document } from 'mongoose';


export const PaymentSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, refPath: 'userType', required: false },
    userType: { type: String, enum: ['Influencer', 'Brand', 'Photographer'], required: true },
    userSnapshot: {
      name: { type: String },
      email: { type: String },
    },
    transactionId: { type: String, required: true, unique: true },
    orderId: { type: String, index: true },
    paymentId: { type: String, index: true },
    amount: { type: Number, required: true }, // in paise (e.g., 39900 for ₹399)
    premiumDuration: { type: String, enum: ['1m', '3m', '1y'], required: true },
    purpose: {
      type: String,
      enum: ['subscription', 'invite_unlock', 'campaign_payment'],
      default: 'subscription',
      index: true,
    },
    paymentStatus: {
      type: String,
      enum: ['created', 'authorized', 'captured', 'failed', 'refunded'],
      default: 'created',
      index: true,
    },
    refundStatus: {
      type: String,
      enum: ['none', 'requested', 'processed', 'failed'],
      default: 'none',
    },
    gatewayProvider: {
      type: String,
      enum: ['manual_upi', 'razorpay'],
      default: 'manual_upi',
    },
    gatewaySignature: { type: String },
    gatewayVerifiedAt: { type: Date },
    feeBreakdown: {
      baseAmount: { type: Number, default: 0 },
      commissionPercent: { type: Number, default: 0 },
      commissionAmount: { type: Number, default: 0 },
      gstPercent: { type: Number, default: 0 },
      gstAmount: { type: Number, default: 0 },
      totalAmount: { type: Number, default: 0 },
    },
    metadata: { type: Schema.Types.Mixed, default: {} },
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected'],
      default: 'pending',
    },
    paymentMethod: { type: String, enum: ['upi', 'qr'], default: 'upi' },
    approvedBy: { type: Schema.Types.ObjectId, ref: 'Admin' },
    approvalNotes: { type: String },
    createdAt: { type: Date, default: Date.now },
    approvedAt: { type: Date },
  },
  { timestamps: true },
);

export interface Payment extends Document {
  userId: string;
  userType: 'Influencer' | 'Brand' | 'Photographer';
  transactionId: string;
  orderId?: string;
  paymentId?: string;
  amount: number;
  premiumDuration: '1m' | '3m' | '1y';
  purpose: 'subscription' | 'invite_unlock' | 'campaign_payment';
  paymentStatus: 'created' | 'authorized' | 'captured' | 'failed' | 'refunded';
  refundStatus: 'none' | 'requested' | 'processed' | 'failed';
  gatewayProvider: 'manual_upi' | 'razorpay';
  gatewaySignature?: string;
  gatewayVerifiedAt?: Date;
  status: 'pending' | 'approved' | 'rejected';
  paymentMethod: 'upi' | 'qr';
  feeBreakdown?: {
    baseAmount: number;
    commissionPercent: number;
    commissionAmount: number;
    gstPercent: number;
    gstAmount: number;
    totalAmount: number;
  };
  metadata?: Record<string, any>;
  approvedBy?: string;
  approvalNotes?: string;
  createdAt: Date;
  approvedAt?: Date;
}
