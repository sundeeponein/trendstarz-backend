jest.mock("../utils/app-email.service", () => ({
  sendAppEmail: jest.fn().mockResolvedValue(undefined),
}));

import { Test, TestingModule } from "@nestjs/testing";
import { getModelToken } from "@nestjs/mongoose";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { CampaignInvitesService } from "./campaign-invites.service";
import { PlansService } from "../plans/plans.service";
import { sendAppEmail } from "../utils/app-email.service";

describe("CampaignInvitesService (admin disputes + remind)", () => {
  let service: CampaignInvitesService;
  let inviteModel: any;
  let brandModel: any;
  let influencerModel: any;
  let campaignModel: any;

  beforeEach(async () => {
    inviteModel = jest.fn();
    inviteModel.findById = jest.fn();
    inviteModel.countDocuments = jest.fn();
    inviteModel.find = jest.fn();

    brandModel = jest.fn();
    brandModel.findById = jest.fn();
    brandModel.find = jest.fn();

    influencerModel = jest.fn();
    influencerModel.findById = jest.fn();
    influencerModel.find = jest.fn();

    campaignModel = jest.fn();
    campaignModel.findById = jest.fn();
    campaignModel.find = jest.fn();

    const submissionModel: any = {};
    const txnModel: any = {};

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CampaignInvitesService,
        { provide: getModelToken("CampaignInvite"), useValue: inviteModel },
        {
          provide: getModelToken("CampaignSubmission"),
          useValue: submissionModel,
        },
        { provide: getModelToken("Campaign"), useValue: campaignModel },
        { provide: getModelToken("Brand"), useValue: brandModel },
        { provide: getModelToken("Influencer"), useValue: influencerModel },
        {
          provide: getModelToken("CampaignTransaction"),
          useValue: txnModel,
        },
        { provide: PlansService, useValue: {} },
      ],
    }).compile();

    service = module.get<CampaignInvitesService>(CampaignInvitesService);
    (sendAppEmail as jest.Mock).mockClear();
  });

  describe("adminCountOpenDisputes", () => {
    it("counts disputed invites with unresolved reportedIssue", async () => {
      inviteModel.countDocuments.mockResolvedValue(7);
      const result = await service.adminCountOpenDisputes();
      expect(inviteModel.countDocuments).toHaveBeenCalledWith({
        status: "disputed",
        "reportedIssue.resolvedAt": { $in: [null, undefined] },
      });
      expect(result).toEqual({ count: 7 });
    });
  });

  describe("adminResolveDispute", () => {
    it("throws NotFound when invite missing", async () => {
      inviteModel.findById.mockResolvedValue(null);
      await expect(service.adminResolveDispute("x")).rejects.toThrow(
        NotFoundException,
      );
    });

    it("throws BadRequest when invite has no reportedIssue", async () => {
      inviteModel.findById.mockResolvedValue({
        reportedIssue: undefined,
      });
      await expect(service.adminResolveDispute("x")).rejects.toThrow(
        BadRequestException,
      );
    });

    it("sets resolvedAt and flips status when outcome supplied", async () => {
      const save = jest.fn().mockResolvedValue(undefined);
      const invite: any = {
        _id: "i1",
        status: "disputed",
        reportedIssue: { reportedAt: new Date(), reason: "broken" },
        save,
      };
      inviteModel.findById.mockResolvedValue(invite);

      const result = await service.adminResolveDispute("i1", {
        outcome: "completed",
        note: "reviewed",
      });

      expect(invite.reportedIssue.resolvedAt).toBeInstanceOf(Date);
      expect(invite.reportedIssue.reason).toContain("broken");
      expect(invite.reportedIssue.reason).toContain("[admin");
      expect(invite.reportedIssue.reason).toContain("reviewed");
      expect(invite.status).toBe("completed");
      expect(save).toHaveBeenCalled();
      expect(result).toEqual({ success: true, status: "completed" });
    });

    it("sets withdrawnAt when outcome=withdrawn", async () => {
      const save = jest.fn().mockResolvedValue(undefined);
      const invite: any = {
        status: "disputed",
        reportedIssue: { reportedAt: new Date() },
        save,
      };
      inviteModel.findById.mockResolvedValue(invite);
      await service.adminResolveDispute("i", { outcome: "withdrawn" });
      expect(invite.withdrawnAt).toBeInstanceOf(Date);
      expect(invite.status).toBe("withdrawn");
    });
  });

  describe("remindInvite throttle", () => {
    function brandOwnedInvite(overrides: any = {}) {
      const save = jest.fn().mockResolvedValue(undefined);
      return {
        _id: "inv1",
        brandId: "brand1",
        influencerId: "inf1",
        campaignId: "camp1",
        status: "pending",
        save,
        ...overrides,
      };
    }

    function mockChainSelectLean(value: any) {
      return {
        select: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue(value),
        }),
      };
    }

    beforeEach(() => {
      // brand ownership lookup fallback used inside assertBrandOwnsInvite
      brandModel.findById.mockReturnValue(
        mockChainSelectLean({ brandUsername: "brand1" }),
      );
      influencerModel.findById.mockReturnValue({
        select: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue({
            email: "inf@example.com",
            name: "Inf",
          }),
        }),
      });
      campaignModel.findById.mockReturnValue({
        select: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue({ title: "Campaign X" }),
        }),
      });
    });

    it("sends a reminder and email on first call", async () => {
      const invite = brandOwnedInvite();
      inviteModel.findById.mockResolvedValue(invite);
      // brand lookup for email enrichment
      brandModel.findById
        .mockReturnValueOnce(mockChainSelectLean({ brandUsername: "brand1" })) // assertBrandOwnsInvite no-op (skipped because brandId matches)
        .mockReturnValueOnce(mockChainSelectLean({ name: "Brand X" })); // email enrichment
      const res = await service.remindInvite("inv1", "brand1");
      expect(invite.remindersSent).toBe(1);
      expect(invite.remindedAt).toBeInstanceOf(Date);
      expect(invite.save).toHaveBeenCalled();
      expect(sendAppEmail).toHaveBeenCalledTimes(1);
      const call = (sendAppEmail as jest.Mock).mock.calls[0][0];
      expect(call.to).toBe("inf@example.com");
      expect(call.html).toContain("Campaign X");
      expect(res.success).toBe(true);
    });

    it("rejects a second reminder within 24h", async () => {
      const invite = brandOwnedInvite({
        remindedAt: new Date(),
        remindersSent: 1,
      });
      inviteModel.findById.mockResolvedValue(invite);
      brandModel.findById.mockReturnValue(
        mockChainSelectLean({ name: "Brand X" }),
      );
      await expect(service.remindInvite("inv1", "brand1")).rejects.toThrow(
        BadRequestException,
      );
      expect(sendAppEmail).not.toHaveBeenCalled();
    });

    it("allows a reminder after 24h", async () => {
      const invite = brandOwnedInvite({
        remindedAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
        remindersSent: 1,
      });
      inviteModel.findById.mockResolvedValue(invite);
      brandModel.findById.mockReturnValue(
        mockChainSelectLean({ name: "Brand X" }),
      );
      const res = await service.remindInvite("inv1", "brand1");
      expect(res.success).toBe(true);
      expect(invite.remindersSent).toBe(2);
    });
  });
});
