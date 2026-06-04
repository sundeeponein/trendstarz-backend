import { Injectable, BadRequestException } from "@nestjs/common";
import * as admin from "firebase-admin";

@Injectable()
export class FirebaseAdminService {
  private app: admin.app.App | null = null;

  isConfigured(): boolean {
    return !!(
      (process.env.FIREBASE_PROJECT_ID &&
        process.env.FIREBASE_CLIENT_EMAIL &&
        process.env.FIREBASE_PRIVATE_KEY) ||
      process.env.GOOGLE_APPLICATION_CREDENTIALS
    );
  }

  private getApp(): admin.app.App {
    if (this.app) return this.app;
    if (admin.apps.length) {
      this.app = admin.apps[0] || null;
      if (this.app) return this.app;
    }

    const projectId = process.env.FIREBASE_PROJECT_ID;
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");

    if (projectId && clientEmail && privateKey) {
      this.app = admin.initializeApp({
        credential: admin.credential.cert({
          projectId,
          clientEmail,
          privateKey,
        }),
      });
      return this.app;
    }

    if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      this.app = admin.initializeApp({
        credential: admin.credential.applicationDefault(),
      });
      return this.app;
    }

    throw new BadRequestException("Firebase Admin is not configured.");
  }

  async verifyIdToken(idToken: string): Promise<admin.auth.DecodedIdToken> {
    if (!idToken) {
      throw new BadRequestException("Firebase ID token is required.");
    }
    try {
      return await this.getApp().auth().verifyIdToken(idToken);
    } catch {
      throw new BadRequestException("Invalid Firebase ID token.");
    }
  }

  async ensureEmailUser(email: string): Promise<admin.auth.UserRecord> {
    const auth = this.getApp().auth();
    try {
      return await auth.getUserByEmail(email);
    } catch (error: any) {
      if (error?.code !== "auth/user-not-found") throw error;
      return auth.createUser({ email });
    }
  }

  async generateEmailVerificationLink(email: string): Promise<string> {
    await this.ensureEmailUser(email);
    const frontendBase = (
      process.env.FRONTEND_URL || "https://www.trendstarz.in"
    ).replace(/\/$/, "");
    return this.getApp()
      .auth()
      .generateEmailVerificationLink(email, {
        url: `${frontendBase}/verify-email?firebaseEmail=${encodeURIComponent(email)}`,
        handleCodeInApp: false,
      });
  }

  async setUserRoleClaim(email: string, role: string): Promise<void> {
    const user = await this.ensureEmailUser(email);
    await this.getApp().auth().setCustomUserClaims(user.uid, {
      ...(user.customClaims || {}),
      role,
      trendstarzRole: role,
    });
  }

  async isFirebaseEmailVerified(email: string): Promise<boolean> {
    try {
      const user = await this.getApp().auth().getUserByEmail(email);
      return !!user.emailVerified;
    } catch {
      return false;
    }
  }

  async listEmailUsers(maxResults = 1000): Promise<admin.auth.UserRecord[]> {
    const result = await this.getApp().auth().listUsers(maxResults);
    return result.users.filter((user) => !!user.email);
  }
}
