import { Schema, Document } from 'mongoose';


export const PaymentSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, refPath: 'userType', required: false },
    userType: { type: String, enum: ['Influencer', 'Brand'], required: true },
    userSnapshot: {
      name: { type: String },
      email: { type: String },
    },
    transactionId: { type: String, required: true, unique: true },
    amount: { type: Number, required: true }, // in paise (e.g., 39900 for ₹399)
    premiumDuration: { type: String, enum: ['1m', '3m', '1y'], required: true },
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
  userType: 'Influencer' | 'Brand';
  transactionId: string;
  amount: number;
  premiumDuration: '1m' | '3m' | '1y';
  status: 'pending' | 'approved' | 'rejected';
  paymentMethod: 'upi' | 'qr';
  approvedBy?: string;
  approvalNotes?: string;
  createdAt: Date;
  approvedAt?: Date;
}
