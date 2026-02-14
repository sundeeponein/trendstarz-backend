import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import VerificationToken from '../models/verificationToken.model';
// @ts-ignore: missing type declarations for ../models/user.model
import User from '../models/user.model';
import { EmailProvider } from './emailProvider.service';
import { SmsProvider } from './smsProvider.service';

export class VerificationService {
  constructor(
    private emailProvider: EmailProvider,
    private smsProvider: SmsProvider
  ) {}

  async generateToken(userId: string, type: 'email' | 'mobile'): Promise<string> {
    const user = await User.findById(userId);
    if (!user) throw new Error('User not found');
    if ((type === 'email' && user.isEmailVerified) || (type === 'mobile' && user.isMobileVerified)) {
      throw new Error('Already verified');
    }
    await VerificationToken.deleteMany({ userId, type });
    const rawToken = type === 'email'
      ? crypto.randomBytes(32).toString('hex')
      : Math.floor(100000 + Math.random() * 900000).toString();
    const hashedToken = await bcrypt.hash(rawToken, 10);
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    await VerificationToken.create({ userId, type, token: hashedToken, expiresAt });
    return rawToken;
  }

  async verifyToken(userId: string, type: 'email' | 'mobile', tokenInput: string): Promise<void> {
    const tokenDoc = await VerificationToken.findOne({ userId, type });
    if (!tokenDoc) throw new Error('Token expired or not found');
    if (tokenDoc.attempts >= 5) throw new Error('Too many attempts');
    const isMatch = await bcrypt.compare(tokenInput, tokenDoc.token);
    if (!isMatch) {
      tokenDoc.attempts += 1;
      await tokenDoc.save();
      throw new Error('Invalid token');
    }
    // Atomic update
    await User.findOneAndUpdate(
      { _id: userId },
      type === 'email' ? { isEmailVerified: true } : { isMobileVerified: true },
      { new: true }
    );
    await VerificationToken.deleteOne({ _id: tokenDoc._id });
  }
}
