import { Schema, model, Document, Types } from 'mongoose';

export interface VerificationTokenDocument extends Document {
  userId: Types.ObjectId;
  type: 'email' | 'mobile';
  token: string;
  attempts: number;
  expiresAt: Date;
}

const verificationTokenSchema = new Schema<VerificationTokenDocument>({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  type: { type: String, enum: ['email', 'mobile'], required: true },
  token: { type: String, required: true },
  attempts: { type: Number, default: 0 },
  expiresAt: { type: Date, required: true, index: { expires: 0 } },
}, { timestamps: true });

verificationTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default model<VerificationTokenDocument>('VerificationToken', verificationTokenSchema);
