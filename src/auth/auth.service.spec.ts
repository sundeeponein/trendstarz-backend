import { Test, TestingModule } from "@nestjs/testing";
import { getModelToken } from "@nestjs/mongoose";
import {
  UnauthorizedException,
  BadRequestException,
  NotFoundException,
  InternalServerErrorException,
} from "@nestjs/common";
import { AuthService } from "./auth.service";
import * as bcrypt from "bcryptjs";
import { FirebaseAdminService } from "../utils/firebase-admin.service";
import { CloudinaryService } from "../cloudinary.service";
import { WhatsAppService } from "../whatsapp/whatsapp.service";

// Mock external dependencies
jest.mock("bcryptjs");
jest.mock("jsonwebtoken", () => ({
  sign: jest.fn().mockReturnValue("mock-jwt-token"),
  verify: jest.fn(),
}));
jest.mock("../utils/app-email.service", () => ({
  sendAppEmail: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("./jwt-secret", () => ({
  getJwtSecret: jest.fn().mockReturnValue("test-secret"),
}));

import * as jwt from "jsonwebtoken";
import { sendAppEmail } from "../utils/app-email.service";

describe("AuthService", () => {
  let service: AuthService;
  let userModel: any;
  let influencerModel: any;
  let brandModel: any;
  let appSettingsModel: any;

  const hashedPw = "$2a$10$hashedpassword";
  const mockAdmin = {
    _id: "admin1",
    email: "admin@test.com",
    name: "Admin",
    password: hashedPw,
    role: "admin",
    profileImages: [{ url: "img.jpg" }],
  };
  const mockInfluencer = {
    _id: "inf1",
    email: "inf@test.com",
    name: "Influencer",
    username: "influencer1",
    password: hashedPw,
    status: "accepted",
    isDeleted: false,
    isEmailVerified: true,
    profileImages: [{ url: "inf.jpg" }],
    isPremium: false,
    premiumEnd: null,
    save: jest.fn().mockResolvedValue(undefined),
  };
  const mockBrand = {
    _id: "brand1",
    email: "brand@test.com",
    brandName: "TestBrand",
    password: hashedPw,
    status: "accepted",
    isDeleted: false,
    isEmailVerified: true,
    brandLogo: [{ url: "logo.jpg" }],
    isPremium: false,
    premiumEnd: null,
    save: jest.fn().mockResolvedValue(undefined),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    (bcrypt.compare as jest.Mock).mockResolvedValue(true);
    (bcrypt.hash as jest.Mock).mockResolvedValue(hashedPw);

    const createMockModel = () => ({
      findOne: jest.fn().mockResolvedValue(null),
      find: jest
        .fn()
        .mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }),
      findById: jest
        .fn()
        .mockReturnValue({ lean: jest.fn().mockResolvedValue(null) }),
      updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
      exists: jest.fn().mockResolvedValue(null),
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: getModelToken("User"), useValue: createMockModel() },
        {
          provide: getModelToken("Influencer"),
          useValue: { ...createMockModel(), constructor: jest.fn() },
        },
        {
          provide: getModelToken("Brand"),
          useValue: { ...createMockModel(), constructor: jest.fn() },
        },
        {
          provide: getModelToken("Photographer"),
          useValue: { ...createMockModel(), constructor: jest.fn() },
        },
        { provide: getModelToken("Category"), useValue: createMockModel() },
        { provide: getModelToken("State"), useValue: createMockModel() },
        { provide: getModelToken("District"), useValue: createMockModel() },
        { provide: getModelToken("Language"), useValue: createMockModel() },
        { provide: getModelToken("SocialMedia"), useValue: createMockModel() },
        {
          provide: getModelToken("Counter"),
          useValue: {
            findOneAndUpdate: jest.fn().mockResolvedValue({ seq: 1 }),
          },
        },
        { provide: getModelToken("TrackingLink"), useValue: createMockModel() },
        {
          provide: getModelToken("LinkConversion"),
          useValue: createMockModel(),
        },
        {
          provide: getModelToken("AppSettings"),
          useValue: {
            findOne: jest
              .fn()
              .mockReturnValue({ lean: jest.fn().mockResolvedValue({}) }),
          },
        },
        {
          provide: FirebaseAdminService,
          useValue: {
            isConfigured: jest.fn().mockReturnValue(false),
            generateEmailVerificationLink: jest.fn(),
            isFirebaseEmailVerified: jest.fn(),
            ensureEmailUser: jest.fn(),
            setUserRoleClaim: jest.fn(),
            verifyIdToken: jest.fn(),
            setEmailVerified: jest.fn(),
          },
        },
        {
          provide: CloudinaryService,
          useValue: {
            relocateAsset: jest.fn().mockImplementation((asset) => Promise.resolve(asset)),
          },
        },
        {
          provide: WhatsAppService,
          useValue: {
            sendOtp: jest.fn(),
            sendCustomTemplateMessage: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
    userModel = module.get(getModelToken("User"));
    influencerModel = module.get(getModelToken("Influencer"));
    brandModel = module.get(getModelToken("Brand"));
    appSettingsModel = module.get(getModelToken("AppSettings"));
  });

  describe("login", () => {
    it("should return token for admin user", async () => {
      userModel.findOne.mockResolvedValue(mockAdmin);
      const result = await service.login("admin@test.com", "password123");
      expect(result.token).toBe("mock-jwt-token");
      expect(result.userType).toBe("admin");
      expect(result.user.email).toBe("admin@test.com");
    });

    it("should return token for influencer", async () => {
      influencerModel.findOne.mockResolvedValue(mockInfluencer);
      const result = await service.login("inf@test.com", "password123");
      expect(result.token).toBe("mock-jwt-token");
      expect(result.userType).toBe("influencer");
      expect(result.user.role).toBe("influencer");
    });

    it("should return token for brand", async () => {
      brandModel.findOne.mockResolvedValue(mockBrand);
      const result = await service.login("brand@test.com", "password123");
      expect(result.token).toBe("mock-jwt-token");
      expect(result.userType).toBe("brand");
    });

    it("should throw UnauthorizedException for wrong password on admin", async () => {
      userModel.findOne.mockResolvedValue(mockAdmin);
      (bcrypt.compare as jest.Mock).mockResolvedValue(false);
      await expect(service.login("admin@test.com", "wrong")).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it("should throw UnauthorizedException for wrong password on influencer", async () => {
      influencerModel.findOne.mockResolvedValue(mockInfluencer);
      (bcrypt.compare as jest.Mock).mockResolvedValue(false);
      await expect(service.login("inf@test.com", "wrong")).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it("should throw for deleted influencer", async () => {
      influencerModel.findOne.mockResolvedValue({
        ...mockInfluencer,
        isDeleted: true,
      });
      await expect(
        service.login("inf@test.com", "password123"),
      ).rejects.toThrow("Your account has been deleted");
    });

    it("should throw for pending influencer", async () => {
      influencerModel.findOne.mockResolvedValue({
        ...mockInfluencer,
        status: "pending",
      });
      await expect(
        service.login("inf@test.com", "password123"),
      ).rejects.toThrow("pending approval");
    });

    it("should block unverified influencer login", async () => {
      influencerModel.findOne.mockResolvedValue({
        ...mockInfluencer,
        isEmailVerified: false,
      });
      await expect(
        service.login("inf@test.com", "password123"),
      ).rejects.toThrow("Firebase verification is required");
    });

    it("should throw for deleted brand", async () => {
      brandModel.findOne.mockResolvedValue({ ...mockBrand, isDeleted: true });
      await expect(
        service.login("brand@test.com", "password123"),
      ).rejects.toThrow("Your account has been deleted");
    });
  });

  describe("resetPassword", () => {
    it("should throw if token or password missing", async () => {
      await expect(service.resetPassword("", "newpass12")).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.resetPassword("tok", "")).rejects.toThrow(
        BadRequestException,
      );
    });

    it("should throw for short password", async () => {
      await expect(service.resetPassword("tok", "short")).rejects.toThrow(
        "at least 8 characters",
      );
    });

    it("should throw for too long password", async () => {
      await expect(
        service.resetPassword("tok", "a".repeat(129)),
      ).rejects.toThrow("must not exceed 128");
    });

    it("should throw if token not found in any collection", async () => {
      await expect(
        service.resetPassword("validtoken", "Newpassword@123"),
      ).rejects.toThrow("Invalid or expired reset token");
    });

    it("should reset password when valid token found", async () => {
      const mockUser = {
        password: "old",
        isEmailVerified: false,
        resetToken: "hash",
        resetTokenExpires: Date.now() + 100000,
        save: jest.fn().mockResolvedValue(undefined),
      };
      userModel.findOne.mockResolvedValue(mockUser);
      const result = await service.resetPassword(
        "validtoken",
        "Newpassword@123",
      );
      expect(result.success).toBe(true);
      expect(mockUser.save).toHaveBeenCalled();
      expect(mockUser.isEmailVerified).toBe(true);
      expect(mockUser.resetToken).toBeNull();
    });
  });

  describe("forgotPassword", () => {
    it("should silently return if email not found", async () => {
      await expect(
        service.forgotPassword("unknown@test.com"),
      ).resolves.toBeUndefined();
    });

    it("should set reset token and send email", async () => {
      const mockUser = {
        email: "user@test.com",
        resetToken: null as string | null,
        resetTokenExpires: null as number | null,
        save: jest.fn().mockResolvedValue(undefined),
      };
      userModel.findOne.mockResolvedValue(mockUser);
      await service.forgotPassword("user@test.com");
      expect(mockUser.save).toHaveBeenCalled();
      expect(mockUser.save.mock.invocationCallOrder[0]).toBeLessThan(
        (sendAppEmail as jest.Mock).mock.invocationCallOrder[0],
      );
      expect(mockUser.resetToken).toBeTruthy();
      expect(sendAppEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: "user@test.com",
          subject: "Reset your TrendStarz password",
        }),
      );
    });
  });

  describe("verifyEmailByToken", () => {
    it("should throw for missing token", async () => {
      await expect(service.verifyEmailByToken("")).rejects.toThrow(
        BadRequestException,
      );
    });

    it("should throw for invalid JWT", async () => {
      (jwt.verify as jest.Mock).mockImplementation(() => {
        throw new Error("invalid");
      });
      await expect(service.verifyEmailByToken("bad-token")).rejects.toThrow(
        BadRequestException,
      );
    });

    it("should verify email and return success", async () => {
      (jwt.verify as jest.Mock).mockReturnValue({
        email: "inf@test.com",
        purpose: "email_verification",
      });
      const saveable = {
        ...mockInfluencer,
        isEmailVerified: false,
        save: jest.fn().mockResolvedValue(undefined),
      };
      influencerModel.findOne.mockResolvedValue(saveable);
      appSettingsModel.findOne.mockReturnValue({
        lean: jest.fn().mockResolvedValue({ preApproveInfluencers: false }),
      });

      const result = await service.verifyEmailByToken("valid-token");
      expect(result.success).toBe(true);
      expect(result.message).toBe("Email verified successfully.");
      expect(saveable.isEmailVerified).toBe(true);
      expect(saveable.save).toHaveBeenCalled();
    });

    it("should auto-approve influencer when settings allow", async () => {
      (jwt.verify as jest.Mock).mockReturnValue({
        email: "inf@test.com",
        purpose: "email_verification",
      });
      const saveable = {
        ...mockInfluencer,
        status: "pending",
        isEmailVerified: false,
        isMobileVerified: true,
        save: jest.fn().mockResolvedValue(undefined),
      };
      influencerModel.findOne.mockResolvedValue(saveable);
      appSettingsModel.findOne.mockReturnValue({
        lean: jest.fn().mockResolvedValue({ preApproveInfluencers: true }),
      });

      const result = await service.verifyEmailByToken("valid-token");
      expect(result.autoApproved).toBe(true);
      expect(saveable.status).toBe("accepted");
    });

    it("should return already verified for verified email", async () => {
      (jwt.verify as jest.Mock).mockReturnValue({
        email: "inf@test.com",
        purpose: "email_verification",
      });
      influencerModel.findOne.mockResolvedValue({
        ...mockInfluencer,
        isEmailVerified: true,
        save: jest.fn(),
      });

      const result = await service.verifyEmailByToken("valid-token");
      expect(result.message).toBe("Email already verified.");
    });
  });

  describe("sendEmailVerificationLink", () => {
    it("should throw for empty email", async () => {
      await expect(service.sendEmailVerificationLink("")).rejects.toThrow(
        BadRequestException,
      );
    });

    it("should return success even if user not found (enumeration protection)", async () => {
      const result = await service.sendEmailVerificationLink("nobody@test.com");
      expect(result.success).toBe(true);
    });

    it("should return already verified for verified user", async () => {
      userModel.findOne.mockResolvedValue({
        ...mockAdmin,
        isEmailVerified: true,
      });
      const result = await service.sendEmailVerificationLink("admin@test.com");
      expect(result.message).toBe("Email is already verified.");
    });

    it("should send verification email", async () => {
      userModel.findOne.mockResolvedValue({
        ...mockAdmin,
        isEmailVerified: false,
        save: jest.fn().mockResolvedValue(undefined),
      });
      const result = await service.sendEmailVerificationLink("admin@test.com");
      expect(result.message).toBe("Verification email sent.");
      expect(sendAppEmail).toHaveBeenCalled();
    });
  });

  describe("getPublicSettings", () => {
    it("should return public settings", async () => {
      appSettingsModel.findOne.mockReturnValue({
        lean: jest.fn().mockResolvedValue({
          preApproveInfluencers: true,
          preApproveBrands: false,
        }),
      });
      const result = await service.getPublicSettings();
      expect(result.preApproveInfluencers).toBe(true);
      expect(result.preApproveBrands).toBe(false);
    });
  });

  // ── Password drift between MongoDB and Firebase (users locked out after a reset) ──
  describe("login password self-heal from Firebase", () => {
    let firebase: any;
    const nowSeconds = () => Math.floor(Date.now() / 1000);
    const freshToken = (overrides: any = {}) => ({
      uid: "fb-uid-1",
      email: "inf@test.com",
      email_verified: true,
      auth_time: nowSeconds(),
      firebase: { sign_in_provider: "password" },
      ...overrides,
    });
    const influencerDoc = (overrides: any = {}) => ({
      ...mockInfluencer,
      mustChangePassword: true,
      tempPasswordExpiresAt: new Date(Date.now() + 3600_000),
      save: jest.fn().mockResolvedValue(undefined),
      ...overrides,
    });

    beforeEach(() => {
      firebase = (service as any).firebaseAdminService;
      firebase.isConfigured.mockReturnValue(true);
      (bcrypt.compare as jest.Mock).mockResolvedValue(false); // MongoDB hash is stale
    });

    it("re-syncs MongoDB to the entered password when Firebase just accepted it", async () => {
      const doc = influencerDoc();
      influencerModel.findOne.mockResolvedValue(doc);
      firebase.verifyIdToken.mockResolvedValue(freshToken());

      const result = await service.login(
        "inf@test.com",
        "NewPass#2026",
        "fb-token",
      );

      expect(result.token).toBe("mock-jwt-token");
      expect(bcrypt.hash).toHaveBeenCalledWith("NewPass#2026", 10);
      expect(doc.password).toBe(hashedPw);
      expect(doc.firebaseUid).toBe("fb-uid-1");
      expect(doc.mustChangePassword).toBe(false);
      expect(doc.save).toHaveBeenCalled();
    });

    it.each([
      ["no Firebase token", undefined, freshToken()],
      [
        "a stale Firebase sign-in (older than 5 minutes)",
        "t",
        freshToken({ auth_time: nowSeconds() - 10 * 60 }),
      ],
      [
        "a non-password sign-in (e.g. phone)",
        "t",
        freshToken({ firebase: { sign_in_provider: "phone" } }),
      ],
      ["a different email", "t", freshToken({ email: "someone@else.com" })],
      [
        "an unverified Firebase email",
        "t",
        freshToken({ email_verified: false }),
      ],
    ])("refuses with %s", async (_label, token, decoded) => {
      const doc = influencerDoc();
      influencerModel.findOne.mockResolvedValue(doc);
      firebase.verifyIdToken.mockResolvedValue(decoded);

      await expect(
        service.login("inf@test.com", "Wrong#2026", token as any),
      ).rejects.toThrow("Invalid credentials");
      expect(bcrypt.hash).not.toHaveBeenCalled();
      expect(doc.save).not.toHaveBeenCalled();
    });

    it("refuses when the Firebase token is invalid", async () => {
      influencerModel.findOne.mockResolvedValue(influencerDoc());
      firebase.verifyIdToken.mockRejectedValue(
        new BadRequestException("Invalid Firebase ID token."),
      );
      await expect(service.login("inf@test.com", "x", "bad")).rejects.toThrow(
        "Invalid credentials",
      );
      expect(bcrypt.hash).not.toHaveBeenCalled();
    });

    it("refuses when Firebase Admin is not configured", async () => {
      firebase.isConfigured.mockReturnValue(false);
      influencerModel.findOne.mockResolvedValue(influencerDoc());
      await expect(service.login("inf@test.com", "x", "t")).rejects.toThrow(
        "Invalid credentials",
      );
      expect(firebase.verifyIdToken).not.toHaveBeenCalled();
    });
  });

  describe("temporary password at login", () => {
    it("logs in and tells the app to force a password change", async () => {
      influencerModel.findOne.mockResolvedValue({
        ...mockInfluencer,
        mustChangePassword: true,
        tempPasswordExpiresAt: new Date(Date.now() + 3600_000),
      });
      const result: any = await service.login("inf@test.com", "Temp#Pass2026");
      expect(result.user.mustChangePassword).toBe(true);
    });

    it("rejects an expired temporary password", async () => {
      influencerModel.findOne.mockResolvedValue({
        ...mockInfluencer,
        mustChangePassword: true,
        tempPasswordExpiresAt: new Date(Date.now() - 1000),
      });
      await expect(
        service.login("inf@test.com", "Temp#Pass2026"),
      ).rejects.toThrow(/temporary password has expired/);
    });

    it("reports mustChangePassword false for normal accounts", async () => {
      influencerModel.findOne.mockResolvedValue(mockInfluencer);
      const result: any = await service.login("inf@test.com", "password123");
      expect(result.user.mustChangePassword).toBe(false);
    });
  });

  describe("issueTemporaryPassword", () => {
    let firebase: any;
    const pendingInfluencer = (overrides: any = {}) => ({
      _id: "inf1",
      email: "Inf@Test.com",
      name: "Asha",
      status: "pending",
      isEmailVerified: false,
      password: "old-hash",
      resetToken: "abc",
      // The user clicked "Forgot password" 10 minutes ago.
      passwordResetRequestedAt: new Date(Date.now() - 10 * 60_000),
      tempPasswordIssuedAt: null,
      save: jest.fn().mockResolvedValue(undefined),
      ...overrides,
    });

    beforeEach(() => {
      firebase = (service as any).firebaseAdminService;
      firebase.isConfigured.mockReturnValue(true);
      firebase.setEmailUserPassword = jest
        .fn()
        .mockResolvedValue({ uid: "fb-uid-9" });
    });

    it("sets the password in Firebase and MongoDB, verifies the email and emails it — without returning it", async () => {
      const doc: any = pendingInfluencer();
      influencerModel.findById.mockResolvedValue(doc);
      const before = Date.now();

      const result: any = await service.issueTemporaryPassword(
        "influencer",
        "inf1",
        "admin-7",
      );

      const [fbEmail, tempPassword, fbVerified] =
        firebase.setEmailUserPassword.mock.calls[0];
      expect(fbEmail).toBe("inf@test.com");
      expect(fbVerified).toBe(true);
      expect(tempPassword).toHaveLength(14);
      expect((service as any).isStrongPassword(tempPassword)).toBe(true);
      expect(bcrypt.hash).toHaveBeenCalledWith(tempPassword, 10);

      expect(doc).toMatchObject({
        password: hashedPw,
        isEmailVerified: true,
        firebaseUid: "fb-uid-9",
        mustChangePassword: true,
        tempPasswordIssuedBy: "admin-7",
        resetToken: null,
        // Admin approval is a separate decision — untouched.
        status: "pending",
      });
      const ttl = new Date(doc.tempPasswordExpiresAt).getTime() - before;
      expect(ttl).toBeGreaterThanOrEqual(24 * 3600_000 - 1000);
      expect(ttl).toBeLessThanOrEqual(24 * 3600_000 + 1000);
      expect(doc.save).toHaveBeenCalled();

      const mail = (sendAppEmail as jest.Mock).mock.calls[0][0];
      expect(mail.to).toBe("Inf@Test.com");
      expect(mail.text).toContain(tempPassword);
      expect(JSON.stringify(result)).not.toContain(tempPassword);
      expect(result).toMatchObject({ success: true, email: "Inf@Test.com" });
    });

    describe("only after the user clicked Forgot password", () => {
      it("refuses when the user never requested a reset", async () => {
        influencerModel.findById.mockResolvedValue(
          pendingInfluencer({ passwordResetRequestedAt: null }),
        );
        await expect(
          service.issueTemporaryPassword("influencer", "inf1", "a"),
        ).rejects.toThrow(/click "Forgot password" first/);
        expect(firebase.setEmailUserPassword).not.toHaveBeenCalled();
      });

      it("refuses when the request is older than 24 hours", async () => {
        influencerModel.findById.mockResolvedValue(
          pendingInfluencer({
            passwordResetRequestedAt: new Date(Date.now() - 25 * 3600_000),
          }),
        );
        await expect(
          service.issueTemporaryPassword("influencer", "inf1", "a"),
        ).rejects.toThrow(/within 24 hours/);
      });

      it("allows only one temporary password per request", async () => {
        influencerModel.findById.mockResolvedValue(
          pendingInfluencer({
            tempPasswordIssuedAt: new Date(Date.now() - 60_000),
          }),
        );
        await expect(
          service.issueTemporaryPassword("influencer", "inf1", "a"),
        ).rejects.toThrow(/already sent for this request/);
        expect(firebase.setEmailUserPassword).not.toHaveBeenCalled();
      });

      it("allows another after the user requests a reset again", async () => {
        const doc: any = pendingInfluencer({
          tempPasswordIssuedAt: new Date(Date.now() - 2 * 3600_000),
          passwordResetRequestedAt: new Date(Date.now() - 60_000),
        });
        influencerModel.findById.mockResolvedValue(doc);
        await service.issueTemporaryPassword("influencer", "inf1", "a");
        expect(new Date(doc.tempPasswordIssuedAt).getTime()).toBeGreaterThan(
          Date.now() - 5000,
        );
      });

      it("leaves the request usable when the email fails, so the admin can retry", async () => {
        const doc: any = pendingInfluencer();
        influencerModel.findById.mockResolvedValue(doc);
        (sendAppEmail as jest.Mock).mockRejectedValueOnce(
          new Error("smtp down"),
        );
        await expect(
          service.issueTemporaryPassword("influencer", "inf1", "a"),
        ).rejects.toThrow(InternalServerErrorException);
        expect(doc.tempPasswordIssuedAt).toBeNull();

        await service.issueTemporaryPassword("influencer", "inf1", "a");
        expect(doc.tempPasswordIssuedAt).toBeInstanceOf(Date);
      });
    });

    describe("recording the Forgot password click", () => {
      it("records it for creators in the Firebase reset flow", async () => {
        influencerModel.findOne.mockResolvedValue({ ...mockInfluencer });
        await service.ensureFirebasePasswordResetUser("inf@test.com");
        expect(influencerModel.updateOne).toHaveBeenCalledWith(
          { _id: "inf1" },
          { $set: { passwordResetRequestedAt: expect.any(Date) } },
        );
      });

      it("never blocks the reset when recording fails", async () => {
        influencerModel.findOne.mockResolvedValue({ ...mockInfluencer });
        influencerModel.updateOne.mockRejectedValueOnce(new Error("db blip"));
        await expect(
          service.ensureFirebasePasswordResetUser("inf@test.com"),
        ).resolves.toMatchObject({
          canSendFirebaseReset: true,
        });
      });

      it("records nothing for admin accounts", async () => {
        userModel.findOne.mockResolvedValue({ ...mockAdmin, save: jest.fn() });
        await service.ensureFirebasePasswordResetUser("admin@test.com");
        expect(userModel.updateOne).not.toHaveBeenCalled();
      });
    });

    it("generates a different strong password every time", () => {
      const seen = new Set<string>();
      for (let i = 0; i < 50; i++) {
        const pw = (service as any).generateTemporaryPassword();
        expect((service as any).isStrongPassword(pw)).toBe(true);
        expect(pw).not.toMatch(/[<>&"'0O1lI]/);
        seen.add(pw);
      }
      expect(seen.size).toBe(50);
    });

    it("changes nothing in MongoDB when Firebase fails", async () => {
      const doc = pendingInfluencer();
      influencerModel.findById.mockResolvedValue(doc);
      firebase.setEmailUserPassword.mockRejectedValue(
        new Error("firebase down"),
      );

      await expect(
        service.issueTemporaryPassword("influencer", "inf1", "a"),
      ).rejects.toThrow("firebase down");
      expect(doc.save).not.toHaveBeenCalled();
      expect(doc.password).toBe("old-hash");
      expect(sendAppEmail).not.toHaveBeenCalled();
    });

    it("tells the admin when the email could not be sent", async () => {
      influencerModel.findById.mockResolvedValue(pendingInfluencer());
      (sendAppEmail as jest.Mock).mockRejectedValueOnce(new Error("smtp down"));
      await expect(
        service.issueTemporaryPassword("influencer", "inf1", "a"),
      ).rejects.toThrow(InternalServerErrorException);
    });

    it("rejects admin/unknown roles, missing and deleted accounts", async () => {
      await expect(
        service.issueTemporaryPassword("admin", "x", "a"),
      ).rejects.toThrow(BadRequestException);
      influencerModel.findById.mockResolvedValue(null);
      await expect(
        service.issueTemporaryPassword("influencer", "x", "a"),
      ).rejects.toThrow(NotFoundException);
      influencerModel.findById.mockResolvedValue(
        pendingInfluencer({ isDeleted: true }),
      );
      await expect(
        service.issueTemporaryPassword("influencer", "inf1", "a"),
      ).rejects.toThrow(BadRequestException);
      expect(firebase.setEmailUserPassword).not.toHaveBeenCalled();
    });
  });

  describe("changing the temporary password", () => {
    it("clears the forced-change flag", async () => {
      const doc: any = {
        ...mockInfluencer,
        mustChangePassword: true,
        tempPasswordExpiresAt: new Date(Date.now() + 3600_000),
        save: jest.fn().mockResolvedValue(undefined),
      };
      influencerModel.findById.mockResolvedValue(doc);

      await service.changePassword(
        "inf1",
        "influencer",
        "Temp#Pass2026",
        "Mine#Pass2026",
        "Mine#Pass2026",
      );

      expect(doc.mustChangePassword).toBe(false);
      expect(doc.tempPasswordExpiresAt).toBeNull();
      expect(doc.save).toHaveBeenCalled();
    });
  });
});
