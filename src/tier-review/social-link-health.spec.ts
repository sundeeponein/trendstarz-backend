import { FakeCollection } from "../payments-payouts/fake-collection.fixture-spec";
import { SocialAccountVerificationService } from "../social-account-verification/social-account-verification.service";
import { recordSocialEdit } from "../utils/admin-social-edit.util";
import { mergeSocialMediaEntries } from "../utils/social-account.util";
import {
  LINK_HEALTH,
  SocialLinkHealthService,
  handleConfirmDue,
  handleConfirmOverdue,
} from "./social-link-health.service";

const DAY = 24 * 60 * 60 * 1000;
const ACC = "64b0000000000000000000a1";
const PROFILE = "64b0000000000000000000p1".replace("p", "f");
const CHANNEL = "UC" + "a".repeat(22);

const verified = (handle: string) => ({
  status: "verified",
  method: "manual",
  decidedHandle: handle,
  decidedAt: new Date("2026-10-01T10:00:00Z"),
  decidedByName: "Admin User",
});

function verificationService(states: any[] = []) {
  const stateModel = new FakeCollection(states);
  const reviewModel = new FakeCollection([]);
  const userModel = new FakeCollection([{ _id: "admin1", name: "Admin User" }]);
  const service = new SocialAccountVerificationService(
    stateModel as any,
    reviewModel as any,
    userModel as any,
  );
  return { service, stateModel, reviewModel };
}

const entry = (handle = "asha.creates") => ({
  socialAccountId: ACC,
  platformKey: "instagram",
  platform: "Instagram",
  handle,
  tier: "Nano",
});

describe("Social links that keep working", () => {
  describe("90-day handle check", () => {
    const now = new Date("2026-12-31T00:00:00Z");
    const withSocial = (over: Record<string, any> = {}) => ({
      socialMedia: [{ handle: "asha" }],
      createdAt: new Date(now.getTime() - 100 * DAY),
      ...over,
    });

    it("is due 90 days after the last confirmation (or sign-up)", () => {
      expect(handleConfirmDue(withSocial(), now)).toBe(true);
      expect(
        handleConfirmDue(
          withSocial({ socialConfirmedAt: new Date(now.getTime() - 10 * DAY) }),
          now,
        ),
      ).toBe(false);
      expect(
        handleConfirmDue({ socialMedia: [], createdAt: new Date(0) }, now),
      ).toBe(false);
    });

    it("goes to admin re-review only after 14 days unanswered", () => {
      expect(
        handleConfirmOverdue(
          withSocial({
            socialConfirmPromptedAt: new Date(now.getTime() - 15 * DAY),
          }),
          now,
        ),
      ).toBe(true);
      expect(
        handleConfirmOverdue(
          withSocial({
            socialConfirmPromptedAt: new Date(now.getTime() - 5 * DAY),
          }),
          now,
        ),
      ).toBe(false);
      expect(
        handleConfirmOverdue(
          withSocial({
            socialConfirmPromptedAt: new Date(now.getTime() - 15 * DAY),
            socialConfirmedAt: new Date(now.getTime() - 2 * DAY),
          }),
          now,
        ),
      ).toBe(false);
      expect(LINK_HEALTH.confirmEveryDays).toBe(90);
    });
  });

  describe("permanent YouTube id on a profile entry", () => {
    it("a creator's handle change forgets the old channel id; other edits keep it", () => {
      const stored = [
        {
          socialAccountId: ACC,
          platformKey: "youtube",
          platform: "YouTube",
          handle: "oldname",
          tier: "Nano",
          platformAccountId: CHANNEL,
        },
      ];
      const same = mergeSocialMediaEntries(stored, [
        { platform: "YouTube", handle: "@OldName", tier: "Micro" },
      ]);
      expect(same[0].platformAccountId).toBe(CHANNEL);
      const changed = mergeSocialMediaEntries(stored, [
        { platform: "YouTube", handle: "another", tier: "Nano" },
      ]);
      expect(changed[0].platformAccountId).toBeNull();
    });

    it("an edit that confirms the same channel keeps / sets the id", () => {
      const user: any = {
        socialMedia: [
          {
            socialAccountId: ACC,
            platformKey: "youtube",
            platform: "YouTube",
            handle: "old",
            platformAccountId: CHANNEL,
          },
        ],
      };
      recordSocialEdit(user, 0, {
        handle: "renamed",
        platformAccountId: CHANNEL,
        changedByName: "Auto",
      });
      expect(user.socialMedia[0]).toMatchObject({
        handle: "renamed",
        platformAccountId: CHANNEL,
      });
      recordSocialEdit(user, 0, {
        handle: "someoneelse",
        changedByName: "Admin",
      });
      expect(user.socialMedia[0].platformAccountId).toBeNull();
    });
  });

  describe("broken-link reports", () => {
    const params = (over: Record<string, any> = {}) => ({
      profileType: "Influencer" as const,
      profileId: PROFILE,
      entry: entry(),
      reporterId: "host1",
      reporterRole: "brand",
      ...over,
    });

    it("the first report opens the case; the same host can't count twice; another host adds to it", async () => {
      const { service, stateModel } = verificationService([
        {
          profileType: "Influencer",
          profileId: PROFILE,
          socialAccountId: ACC,
          ownership: verified("asha.creates"),
        },
      ]);
      expect(await service.reportBrokenLink(params())).toEqual({
        firstOpen: true,
        status: "open",
      });
      expect(await service.reportBrokenLink(params())).toEqual({
        firstOpen: false,
        status: "open",
      });
      await service.reportBrokenLink(params({ reporterId: "host2" }));
      const report = stateModel.docs[0].linkReport;
      expect(report).toMatchObject({
        status: "open",
        handle: "asha.creates",
        count: 2,
      });
      expect(report.reporters.map((r: any) => r.userId)).toEqual([
        "host1",
        "host2",
      ]);
    });

    it("an open report puts the profile in the admin 'Social changed' filter", async () => {
      const { service } = verificationService([]);
      await service.reportBrokenLink(params());
      const ids = await service.profileIdsWithChangedReviews("Influencer");
      expect(ids.has(PROFILE)).toBe(true);
    });

    it("admin confirm → verified ownership goes back to pending (re-review) and is logged", async () => {
      const { service, stateModel, reviewModel } = verificationService([
        {
          profileType: "Influencer",
          profileId: PROFILE,
          socialAccountId: ACC,
          ownership: verified("asha.creates"),
        },
      ]);
      await service.reportBrokenLink(params());
      await service.resolveLinkReport(
        { userId: "admin1" },
        {
          profileType: "Influencer",
          profileId: PROFILE,
          entry: entry(),
          action: "confirm",
        },
      );
      const state = stateModel.docs[0];
      expect(state.linkReport.status).toBe("confirmed");
      expect(state.ownership).toMatchObject({
        status: "pending",
        invalidatedReason: "link_broken",
      });
      expect(state.ownership.lastDecision.status).toBe("verified");
      expect(reviewModel.docs[0]).toMatchObject({
        reviewType: "ownership",
        previousStatus: "verified",
        newStatus: "pending",
        method: "invalidated",
      });
      expect(
        (await service.profileIdsWithChangedReviews("Influencer")).has(PROFILE),
      ).toBe(true);
      await expect(
        service.resolveLinkReport(
          { userId: "admin1" },
          {
            profileType: "Influencer",
            profileId: PROFILE,
            entry: entry(),
            action: "dismiss",
          },
        ),
      ).rejects.toThrow("no open link report");
    });

    it("admin dismiss → the link works; nothing else changes", async () => {
      const { service, stateModel } = verificationService([
        {
          profileType: "Influencer",
          profileId: PROFILE,
          socialAccountId: ACC,
          ownership: verified("asha.creates"),
        },
      ]);
      await service.reportBrokenLink(params());
      await service.resolveLinkReport(
        { userId: "admin1" },
        {
          profileType: "Influencer",
          profileId: PROFILE,
          entry: entry(),
          action: "dismiss",
        },
      );
      expect(stateModel.docs[0].linkReport.status).toBe("dismissed");
      expect(stateModel.docs[0].ownership.status).toBe("verified");
    });

    it("the creator updating the handle closes the report and sends ownership to re-review", async () => {
      const { service, stateModel } = verificationService([
        {
          profileType: "Influencer",
          profileId: PROFILE,
          socialAccountId: ACC,
          ownership: verified("asha.creates"),
        },
      ]);
      await service.reportBrokenLink(params());
      await service.reconcile("Influencer", PROFILE, [entry("asha.new")]);
      const state = stateModel.docs[0];
      expect(state.linkReport.status).toBe("resolved");
      expect(state.ownership).toMatchObject({
        status: "pending",
        invalidatedReason: "handle_changed",
      });
    });

    it("hosts only see open/confirmed reports, without reporter details", async () => {
      const { service } = verificationService([]);
      await service.reportBrokenLink(params());
      const map = await service.linkReportsForProfile("Influencer", PROFILE);
      expect(map[ACC]).toEqual({ status: "open", since: expect.anything() });
      expect(JSON.stringify(map)).not.toContain("host1");
    });
  });

  describe("nightly YouTube link sync", () => {
    function build(profile: any, observation: any) {
      const doc: any = {
        ...profile,
        socialMedia: profile.socialMedia.map((s: any) => ({ ...s })),
      };
      doc.save = jest.fn(() => Promise.resolve(doc));
      const influencerModel: any = {
        findById: jest.fn(() => Promise.resolve(doc)),
      };
      const connection: any = {
        collection: jest.fn(() => ({
          find: () => ({ toArray: () => Promise.resolve([observation]) }),
        })),
      };
      const verification: any = {
        reconcile: jest.fn(() => Promise.resolve(1)),
      };
      const notifications: any = {
        createForUser: jest.fn(() => Promise.resolve()),
      };
      const push: any = { sendToUser: jest.fn(() => Promise.resolve()) };
      const service = new SocialLinkHealthService(
        connection,
        influencerModel,
        {} as any,
        verification,
        notifications,
        push,
      );
      return { service, doc, verification, notifications };
    }
    const yt = (handle: string, extra: Record<string, any> = {}) => ({
      socialMedia: [
        {
          socialAccountId: ACC,
          platformKey: "youtube",
          platform: "YouTube",
          handle,
          tier: "Nano",
          ...extra,
        },
      ],
    });
    const obs = (over: Record<string, any> = {}) => ({
      profileType: "Influencer",
      profileId: PROFILE,
      socialAccountId: ACC,
      platformKey: "youtube",
      status: "success",
      externalAccountId: CHANNEL,
      requestedHandle: "mychannel",
      handleChangedTo: null,
      ...over,
    });

    it("learns the channel id so the link survives a later rename", async () => {
      const { service, doc, verification } = build(yt("mychannel"), obs());
      expect(await service.syncYoutubeLinks()).toEqual({
        linked: 1,
        renamed: 0,
      });
      expect(doc.socialMedia[0].platformAccountId).toBe(CHANNEL);
      expect(verification.reconcile).not.toHaveBeenCalled();
    });

    it("a rename found by channel id updates the handle, tells the creator and sends it to re-review", async () => {
      const { service, doc, verification, notifications } = build(
        yt("mychannel"),
        obs({ handleChangedTo: "mynewname" }),
      );
      expect(await service.syncYoutubeLinks()).toEqual({
        linked: 0,
        renamed: 1,
      });
      expect(doc.socialMedia[0]).toMatchObject({
        handle: "mynewname",
        platformAccountId: CHANNEL,
      });
      expect(doc.socialMediaEditLog[0]).toMatchObject({
        oldHandle: "mychannel",
        newHandle: "mynewname",
        changedByName: "Auto (YouTube rename)",
      });
      expect(verification.reconcile).toHaveBeenCalled();
      expect(notifications.createForUser).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Your YouTube handle was updated" }),
      );
    });

    it("never attaches a channel to a handle that wasn't the one checked", async () => {
      const { service, doc } = build(
        yt("switchedtoanother"),
        obs({ handleChangedTo: "mynewname" }),
      );
      expect(await service.syncYoutubeLinks()).toEqual({
        linked: 0,
        renamed: 0,
      });
      expect(doc.socialMedia[0].handle).toBe("switchedtoanother");
      expect(doc.socialMedia[0].platformAccountId).toBeUndefined();
    });
  });
});
