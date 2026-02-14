import { Request, Response } from 'express';
import { VerificationService } from '../services/verification.service';
import { DummyEmailProvider } from '../services/emailProvider.service';
import { DummySmsProvider } from '../services/smsProvider.service';

interface AuthenticatedRequest extends Request {
  user: { _id: string; email?: string };
}

const emailProvider = new DummyEmailProvider();
const smsProvider = new DummySmsProvider();
const verificationService = new VerificationService(emailProvider, smsProvider);

export const sendEmailVerification = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user._id; // Assumes auth middleware sets req.user
    if (!req.user.email) {
      return res.status(400).json({ error: 'User has no email to verify' });
    }
    const token = await verificationService.generateToken(userId, 'email');
    const link = `https://yourdomain.com/verify?token=${token}&type=email`;
    await emailProvider.send(req.user.email, 'Verify your email', `<a href="${link}">Verify Email</a>`);
    res.status(200).json({ message: 'Verification email sent' });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
};

export const verify = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { token, type } = req.body;
    const userId = req.user._id;
    await verificationService.verifyToken(userId, type, token);
    res.status(200).json({ message: 'Verified successfully' });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
};
