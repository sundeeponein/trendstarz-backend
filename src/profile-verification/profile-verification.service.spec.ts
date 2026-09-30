import { ProfileVerificationService } from "./profile-verification.service";

/**
 * Stage 3A-0: profile approval is not social-account verification.
 * The profile model below applies $set updates to an in-memory doc so the tests
 * can assert on the resulting state, not just on call arguments.
 */
describe("ProfileVerificationService.adminAction (Stage 3A-0 approval semantics)", () => {
  const admin = { role: "admin", userId: "admin-1", name: "Asha" };

  function setup(initial: Record<string, any>) {
    const doc: Record<string, any> = { ...initial };
    const writes: any[] = [];
    const profileModel = {
      updateOne: jest.fn().mockResolvedValue({ modifiedCount: 0 }), // legacy audit-action rename
      findByIdAndUpdate: jest.fn((id: string, update: any) => {
        writes.push(update);
        Object.assign(doc, update.$set || {});
        if (update.$push?.verificationAuditLog) {
          doc.verificationAuditLog = [
            ...(doc.verificationAuditLog || []),
            update.$push.verificationAuditLog,
          ];
        }
        return Promise.resolve(doc);
      }),
    };
    const flagModel = {
      updateMany: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
    };
    const service = new ProfileVerificationService(
      flagModel as any,
      profileModel as any, // Influencer
      {} as any, // Brand
      {} as any, // Photographer
      {} as any, // User
      {} as any, // WhatsAppService
    );
    jest.spyOn(service as any, "adminDetail").mockResolvedValue({ ok: true });
    return { service, doc, writes, flagModel };
  }

  const touchesCreatorTier = (writes: any[]) =>
    writes.some(
      (w) =>
        "creatorTierVerified" in (w.$set || {}) ||
        "creatorTierVerified" in (w.$unset || {}),
    );

  it.each(["approve", "approve_warning"])(
    "%s does NOT set creatorTierVerified",
    async (action) => {
      const { service, doc, writes } = setup({
        creatorTierVerified: false,
        verificationStatus: "pending",
      });
      await service.adminAction(admin, "Influencer", "inf-1", {
        action,
        notes: "looks good",
      });
      expect(doc.creatorTierVerified).toBe(false);
      expect(touchesCreatorTier(writes)).toBe(false);
    },
  );

  it("leaves an existing creatorTierVerified = true untouched", async () => {
    const { service, doc, writes } = setup({
      creatorTierVerified: true,
      verificationStatus: "pending",
    });
    await service.adminAction(admin, "Influencer", "inf-1", {
      action: "approve",
    });
    expect(doc.creatorTierVerified).toBe(true);
    expect(touchesCreatorTier(writes)).toBe(false);
  });

  it("keeps every other approval side effect unchanged", async () => {
    const { service, doc, flagModel } = setup({
      verificationStatus: "pending",
      adminReviewPending: true,
    });
    await service.adminAction(admin, "Influencer", "inf-1", {
      action: "approve",
      notes: "ok",
    });

    expect(doc).toMatchObject({
      verifiedByTrendStarz: true,
      verificationStatus: "approved",
      adminReviewPending: false,
      profilePhotoVerified: true,
      verificationAdminNotes: "ok",
    });
    expect(doc.approvedAt).toBeInstanceOf(Date);
    expect(doc.verificationAuditLog.at(-1)).toMatchObject({
      action: "approved",
      status: "approved",
      actorRole: "admin",
    });

    // Photo flags are still cleared on approval — and ONLY photo flags.
    expect(flagModel.updateMany).toHaveBeenCalledTimes(1);
    const [filter, update] = flagModel.updateMany.mock.calls[0];
    expect(filter.flagCode.$in).toEqual(
      expect.arrayContaining(["PROFILE_PHOTO_PENDING_REVIEW"]),
    );
    for (const social of [
      "TIER_MISMATCH",
      "FOLLOWER_COUNT_MISMATCH",
      "SOCIAL_LINK_MISSING",
      "SOCIAL_LINK_BROKEN",
    ]) {
      expect(filter.flagCode.$in).not.toContain(social);
    }
    expect(update.$set.status).toBe("Resolved");
  });

  it.each([
    ["request_changes", "pending", "status_changed"],
    ["reject", "rejected", "rejected"],
  ])(
    "%s behaves as before and touches no verification flags",
    async (action, status, auditAction) => {
      const { service, doc, writes, flagModel } = setup({
        verificationStatus: "approved",
        creatorTierVerified: true,
      });
      await service.adminAction(admin, "Influencer", "inf-1", { action });
      expect(doc.verificationAuditLog.at(-1)).toMatchObject({
        action: auditAction,
        status,
      });
      if (action === "reject") expect(doc.verificationStatus).toBe("rejected");
      expect(flagModel.updateMany).not.toHaveBeenCalled();
      expect(touchesCreatorTier(writes)).toBe(false);
      expect(doc.creatorTierVerified).toBe(true);
    },
  );

  it("still rejects unknown actions", async () => {
    const { service } = setup({});
    await expect(
      service.adminAction(admin, "Influencer", "inf-1", {
        action: "verify_everything",
      }),
    ).rejects.toThrow("Invalid moderation action");
  });
});
