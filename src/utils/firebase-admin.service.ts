import { Injectable, BadRequestException } from "@nestjs/common";
import * as admin from "firebase-admin";

@Injectable()
export class FirebaseAdminService {
  private app: admin.app.App | null = null;

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
}
