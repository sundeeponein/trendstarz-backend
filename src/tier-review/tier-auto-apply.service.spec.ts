import { TierAutoApplyService } from "./tier-auto-apply.service";

describe("TierAutoApplyService (nightly YouTube tier correction)", () => {
  const NOW = new Date("2026-10-10T00:00:00.000Z");
  const DAY = 24 * 60 * 60 * 1000;
  const ID = "64b0000000000000000000a1";

  const observation = (profileId: string, over: Record<string, any> = {}) => ({
    profileType: "Influencer",
    profileId,
    socialAccountId: ID,
    platformKey: "youtube",
    source: "youtube",
    status: "success",
    externalAccountId: "UCabcdefghijklmnopqrstuv",
    observedHandle: "smiley__boie",
    observedFollowersCount: 815,
    capturedAt: new Date(NOW.getTime() - DAY),
    ...over,
  });
  const profileDoc = (id: string) => {
    const doc: any = {
      _id: id,
      socialMedia: [
        {
          socialAccountId: ID,
          platformKey: "youtube",
          platform: "YouTube",
          handle: "@smiley__boie",
          tier: "Starter",
        },
      ],
      socialMediaEditLog: [],
      adminSocialNotifications: [],
    };
    doc.save = jest.fn(() => Promise.resolve(doc));
    return doc;
  };

  const setup = (observations: any[], docs: Record<string, any>) => {
    const connection = {
      collection: (name: string) =>
        name === "social_account_observations"
          ? { find: () => ({ toArray: () => Promise.resolve(observations) }) }
          : { findOne: () => Promise.resolve(null) },
    };
    const influencerModel = {
      findById: (id: string) => Promise.resolve(docs[id] ?? null),
    };
    const verification = {
      reconcile: jest.fn().mockResolvedValue(0),
      recordAutomaticTierDecision: jest.fn().mockResolvedValue(undefined),
    };
    const notifications = {
      createForUser: jest.fn().mockResolvedValue(undefined),
    };
    const push = { sendToUser: jest.fn().mockResolvedValue(undefined) };
    const service = new TierAutoApplyService(
      connection as any,
      influencerModel as any,
      {} as any,
      verification as any,
      notifications as any,
      push as any,
    );
    return { service, verification, notifications, push };
  };

  it("applies a passing correction the same way as the pop-up edit, verifies it, and tells the creator", async () => {
    const docs = { inf1: profileDoc("inf1") };
    const { service, verification, notifications, push } = setup(
      [observation("inf1")],
      docs,
    );
    await expect(service.run(NOW)).resolves.toEqual([
      {
        profileType: "Influencer",
        profileId: "inf1",
        from: "Starter",
        to: "Nano",
        action: "change",
      },
    ]);
    const doc = docs.inf1;
    expect(doc.socialMedia[0].tier).toBe("Nano");
    expect(doc.socialMediaEditLog[0]).toMatchObject({
      oldTier: "Starter",
      newTier: "Nano",
      changedByName: "Auto (YouTube observation)",
    });
    expect(doc.adminSocialNotifications[0]).toMatchObject({
      newTier: "Nano",
      seen: false,
    });
    expect(doc.save).toHaveBeenCalled();
    expect(verification.reconcile).toHaveBeenCalled();
    expect(verification.recordAutomaticTierDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        profileType: "Influencer",
        profileId: "inf1",
        decidedByName: "Auto (YouTube observation)",
        note: expect.stringContaining(
          "Changed from Starter to Nano: YouTube showed 815 subscribers",
        ),
      }),
    );
    expect(notifications.createForUser).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "inf1",
        title: "Your YouTube tier is now Nano (101–1,000 followers)",
        url: "/influencer-profile",
      }),
    );
    expect(push.sendToUser).toHaveBeenCalled();
  });

  it("changes nothing when a safeguard fails (here: the channel's handle is someone else's)", async () => {
    const docs = { inf1: profileDoc("inf1") };
    const { service, verification, notifications } = setup(
      [observation("inf1", { observedHandle: "another_channel" })],
      docs,
    );
    await expect(service.run(NOW)).resolves.toEqual([]);
    expect(docs.inf1.socialMedia[0].tier).toBe("Starter");
    expect(docs.inf1.save).not.toHaveBeenCalled();
    expect(verification.recordAutomaticTierDecision).not.toHaveBeenCalled();
    expect(notifications.createForUser).not.toHaveBeenCalled();
  });

  it("skips deleted or missing profiles", async () => {
    const deleted = { ...profileDoc("inf2"), isDeleted: true };
    const { service } = setup([observation("inf2"), observation("gone")], {
      inf2: deleted,
    });
    await expect(service.run(NOW)).resolves.toEqual([]);
  });

  it("a tier that already matches is verified quietly: no edit, no notice, not marked as a correction", async () => {
    const doc = profileDoc("inf1");
    doc.socialMedia[0].tier = "Nano";
    const { service, verification, notifications, push } = setup(
      [observation("inf1")],
      { inf1: doc },
    );
    await expect(service.run(NOW)).resolves.toEqual([
      {
        profileType: "Influencer",
        profileId: "inf1",
        from: "Nano",
        to: "Nano",
        action: "verify",
      },
    ]);
    expect(doc.save).not.toHaveBeenCalled();
    expect(doc.adminSocialNotifications).toEqual([]);
    expect(verification.recordAutomaticTierDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        markAutoApplied: false,
        note: expect.stringContaining("Matches YouTube: 815 subscribers"),
      }),
    );
    expect(notifications.createForUser).not.toHaveBeenCalled();
    expect(push.sendToUser).not.toHaveBeenCalled();
  });
});
