import { Test, TestingModule } from "@nestjs/testing";
import { getModelToken } from "@nestjs/mongoose";
import { UnauthorizedException, BadRequestException } from "@nestjs/common";
import { AuthService } from "./auth.service";
import * as bcrypt from "bcryptjs";

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
    isEmailVerified: false,
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
    isEmailVerified: false,
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
        { provide: getModelToken("Category"), useValue: createMockModel() },
        { provide: getModelToken("State"), useValue: createMockModel() },
        { provide: getModelToken("Language"), useValue: createMockModel() },
        { provide: getModelToken("SocialMedia"), useValue: createMockModel() },
        {
          provide: getModelToken("AppSettings"),
          useValue: {
            findOne: jest
              .fn()
              .mockReturnValue({ lean: jest.fn().mockResolvedValue({}) }),
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
        service.resetPassword("validtoken", "newpassword123"),
      ).rejects.toThrow("Invalid or expired reset token");
    });

    it("should reset password when valid token found", async () => {
      const mockUser = {
        password: "old",
        resetToken: "hash",
        resetTokenExpires: Date.now() + 100000,
        save: jest.fn().mockResolvedValue(undefined),
      };
      userModel.findOne.mockResolvedValue(mockUser);
      const result = await service.resetPassword(
        "validtoken",
        "newpassword123",
      );
      expect(result.success).toBe(true);
      expect(mockUser.save).toHaveBeenCalled();
      expect(mockUser.resetToken).toBeNull();
    });
  });

  describe("forgotPassword", () => {
    it("should throw if email not found", async () => {
      await expect(service.forgotPassword("unknown@test.com")).rejects.toThrow(
        "Email not found",
      );
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
      expect(mockUser.resetToken).toBeTruthy();
      expect(sendAppEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: "user@test.com",
          subject: "Reset your password",
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
});
