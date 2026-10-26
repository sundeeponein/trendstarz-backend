import { BadRequestException } from "@nestjs/common";
import * as bcrypt from "bcryptjs";
import type { Model } from "mongoose";

/**
 * Changing the login email needs the current password. Without it, a stolen
 * session could change the email, then use "Forgot password" on the new address
 * and take the account over (the alert to the old address comes too late).
 */
export async function assertPasswordForEmailChange(
  model: Model<any>,
  accountId: string,
  currentPassword: unknown,
  localAuthBypass = false,
): Promise<void> {
  if (localAuthBypass) return;
  const password = String(currentPassword || "");
  if (!password) {
    throw new BadRequestException("Enter your current password to change your login email.");
  }
  const account: any = await model.findById(accountId).select("+password").lean();
  if (!account?.password || !(await bcrypt.compare(password, account.password))) {
    throw new BadRequestException(
      "The current password is incorrect. If you never set a password (e.g. Google sign-in), set one with Forgot password first.",
    );
  }
}
