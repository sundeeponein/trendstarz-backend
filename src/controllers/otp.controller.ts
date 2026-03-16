import { Request, Response } from "express";

export const sendOtp = async (req: Request, res: Response) => {
  // Example: send OTP to email or phone
  const { type, value } = req.body;
  if (!type || !value) {
    return res.status(400).json({ error: "Missing type or value" });
  }
  // Simulate sending OTP
  // In real app, generate OTP, save to DB, send via email/SMS
  res.status(200).json({ message: `OTP sent to ${type}: ${value}` });
};

export const verifyOtp = async (req: Request, res: Response) => {
  // Example: verify OTP
  const { type, value, otp } = req.body;
  if (!type || !value || !otp) {
    return res.status(400).json({ error: "Missing type, value, or otp" });
  }
  // Simulate OTP verification
  // In real app, check OTP from DB
  if (otp === "123456") {
    return res.status(200).json({ message: "OTP verified successfully" });
  }
  res.status(400).json({ error: "Invalid OTP" });
};
