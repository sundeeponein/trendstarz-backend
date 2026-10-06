import {
  derivePlatformKey,
  isSocialAccountId,
  mergeSocialMediaEntries,
  newSocialAccountId,
  restrictedSocialSummary,
  socialIdentityChanges,
} from "./social-account.util";
import { normalizeSocialMediaList } from "./social-handle.util";

const ID_A = "64b0000000000000000000a1";
const ID_B = "64b0000000000000000000b2";

/** A stored entry carrying server-owned data that later phases (3A-1+) will add. */
const storedInstagram = () => ({
  _id: "subdoc-ig",
  socialAccountId: ID_A,
  platformKey: "instagram",
  platform: "Instagram",
  handle: "creator.one",
  tier: "Mid-Tier",
  followersCount: 0,
  contentTypes: [{ name: "Reel", enabled: true, price: 5000 }],
  selfReportedStats: {
    avgLikes: 120,
    avgComments: 8,
    postFrequencyPerWeek: 3,
    lastUpdatedAt: new Date("2026-09-01"),
  },
  ownershipVerification: {
    status: "verified",
    method: "manual",
    decidedHandle: "creator.one",
  },
  tierVerification: { status: "verified", decidedTier: "Mid-Tier" },
  observedFollowers: {
    count: 37842,
    source: "meta_oauth",
    capturedAt: new Date("2026-09-20"),
  },
  followerRangeCheck: { result: "within" },
  legacy: { tierVerifiedByProfile: true },
});
const storedYoutube = () => ({
  socialAccountId: ID_B,
  platformKey: "youtube",
  platform: "YouTube",
  handle: "creatorchannel",
  tier: "Nano",
  followersCount: 0,
  contentTypes: [],
});

/** What the profile-edit page sends today (rebuilt from the form, no ids, followersCount 0). */
const browserInstagram = (over: any = {}) => ({
  platform: "Instagram",
  handle: "creator.one",
  followersCount: 0,
  tier: "Mid-Tier",
  contentTypes: [{ name: "Reel", enabled: true, price: 6000 }],
  ...over,
});

let counter = 0;
const ids = () => `64b00000000000000000${String(++counter).padStart(4, "0")}`;

describe("social account identity + server-side merge (Stage 3A-0)", () => {
  beforeEach(() => {
    counter = 0;
  });

  describe("stable identity", () => {
    it("keeps the socialAccountId (and Mongo _id) of an existing account on a normal save", () => {
      const [merged] = mergeSocialMediaEntries(
        [storedInstagram()],
        [browserInstagram()],
        ids,
      );
      expect(merged.socialAccountId).toBe(ID_A);
      expect(merged._id).toBe("subdoc-ig");
    });

    it("keeps the id when the handle changes", () => {
      const [merged] = mergeSocialMediaEntries(
        [storedInstagram()],
        [browserInstagram({ handle: "renamed.creator" })],
        ids,
      );
      expect(merged).toMatchObject({
        socialAccountId: ID_A,
        handle: "renamed.creator",
      });
    });

    it("keeps the id when the tier changes", () => {
      const [merged] = mergeSocialMediaEntries(
        [storedInstagram()],
        [browserInstagram({ tier: "Macro" })],
        ids,
      );
      expect(merged).toMatchObject({ socialAccountId: ID_A, tier: "Macro" });
    });

    it("keeps ids when the array order changes", () => {
      const merged = mergeSocialMediaEntries(
        [storedInstagram(), storedYoutube()],
        [
          { platform: "YouTube", handle: "creatorchannel", tier: "Nano" },
          browserInstagram(),
        ],
        ids,
      );
      expect(merged.map((m) => [m.platform, m.socialAccountId])).toEqual([
        ["YouTube", ID_B],
        ["Instagram", ID_A],
      ]);
    });

    it("gives a new account a new server-generated id", () => {
      const merged = mergeSocialMediaEntries(
        [storedInstagram()],
        [
          browserInstagram(),
          { platform: "Facebook", handle: "creatorpage", tier: "Micro" },
        ],
        ids,
      );
      expect(merged[0].socialAccountId).toBe(ID_A);
      expect(merged[1].socialAccountId).toBe("64b000000000000000000001");
      expect(merged[1].platformKey).toBe("facebook");
    });

    it("assigns an id to a stored entry that predates the backfill", () => {
      const legacy = {
        platform: "Instagram",
        handle: "old",
        tier: "Micro",
        followersCount: 0,
      };
      const [merged] = mergeSocialMediaEntries(
        [legacy],
        [browserInstagram({ handle: "old" })],
        ids,
      );
      expect(isSocialAccountId(merged.socialAccountId)).toBe(true);
    });

    it("drops an account the creator removed (unchanged behaviour)", () => {
      const merged = mergeSocialMediaEntries(
        [storedInstagram(), storedYoutube()],
        [browserInstagram()],
        ids,
      );
      expect(merged).toHaveLength(1);
    });

    it("generates 24-hex ObjectId-style ids", () => {
      const a = newSocialAccountId();
      expect(isSocialAccountId(a)).toBe(true);
      expect(newSocialAccountId()).not.toBe(a);
    });
  });

  describe("merge guard: the browser only edits creator fields", () => {
    it("preserves every server-owned field through a save", () => {
      const [merged] = mergeSocialMediaEntries(
        [storedInstagram()],
        [browserInstagram()],
        ids,
      );
      const stored = storedInstagram();
      for (const key of [
        "ownershipVerification",
        "tierVerification",
        "observedFollowers",
        "followerRangeCheck",
        "legacy",
      ]) {
        expect(merged[key]).toEqual((stored as any)[key]);
      }
      expect(merged.contentTypes).toEqual([
        { name: "Reel", enabled: true, price: 6000 },
      ]);
    });

    it("cannot make an account verified, set observed data, or change identity", () => {
      const spoof = normalizeSocialMediaList([
        browserInstagram({
          socialAccountId: "64b0000000000000000000ff",
          platformKey: "youtube",
          followersCount: 999999,
          ownershipVerification: { status: "verified", method: "manual" },
          tierVerification: { status: "verified" },
          observedFollowers: { count: 1, source: "meta_oauth" },
          followerRangeCheck: { result: "within" },
          legacy: { tierVerifiedByProfile: true },
        }),
      ]);
      // New account (nothing stored): nothing spoofed survives.
      const [fresh] = mergeSocialMediaEntries([], spoof, ids);
      expect(fresh.socialAccountId).toBe("64b000000000000000000001");
      expect(fresh.platformKey).toBe("instagram");
      expect(fresh.followersCount).toBe(0);
      for (const key of [
        "ownershipVerification",
        "tierVerification",
        "observedFollowers",
        "followerRangeCheck",
        "legacy",
      ]) {
        expect(fresh[key]).toBeUndefined();
      }

      // Existing unverified account: still cannot verify itself.
      const unverified = {
        ...storedYoutube(),
        platform: "Instagram",
        platformKey: "instagram",
        socialAccountId: ID_A,
      };
      const [existing] = mergeSocialMediaEntries([unverified], spoof, ids);
      expect(existing.socialAccountId).toBe(ID_A);
      expect(existing.ownershipVerification).toBeUndefined();
      expect(existing.observedFollowers).toBeUndefined();
    });

    it("cannot overwrite stored observed data or followersCount with the form's 0", () => {
      const stored = { ...storedInstagram(), followersCount: 41000 };
      const [merged] = mergeSocialMediaEntries(
        [stored],
        normalizeSocialMediaList([browserInstagram({ followersCount: 0 })]),
        ids,
      );
      expect(merged.followersCount).toBe(41000);
      expect(merged.observedFollowers).toEqual(stored.observedFollowers);
    });

    it("keeps selfReportedStats when the form doesn't send them (it used to wipe them)", () => {
      const [merged] = mergeSocialMediaEntries(
        [storedInstagram()],
        [browserInstagram()],
        ids,
      );
      expect(merged.selfReportedStats).toMatchObject({
        avgLikes: 120,
        avgComments: 8,
      });
    });

    it("accepts creator-sent selfReportedStats as plain numbers", () => {
      const [merged] = mergeSocialMediaEntries(
        [storedInstagram()],
        normalizeSocialMediaList([
          browserInstagram({
            selfReportedStats: {
              avgLikes: "250",
              avgComments: "abc",
              evil: true,
            },
          }),
        ]),
        ids,
      );
      expect(merged.selfReportedStats).toMatchObject({
        avgLikes: 250,
        avgComments: null,
        postFrequencyPerWeek: null,
      });
      expect(merged.selfReportedStats.evil).toBeUndefined();
    });

    it("never lets a changed tier alter the observed data or vice versa", () => {
      const [merged] = mergeSocialMediaEntries(
        [storedInstagram()],
        [browserInstagram({ tier: "Mega / Celebrity" })],
        ids,
      );
      expect(merged.tier).toBe("Mega / Celebrity");
      expect(merged.observedFollowers.count).toBe(37842);
    });
  });

  describe("normalizeSocialMediaList whitelist", () => {
    it("passes only creator-editable fields", () => {
      const [out] = normalizeSocialMediaList([
        browserInstagram({
          socialAccountId: "x",
          platformKey: "x",
          foo: "bar",
          ownershipVerification: { status: "verified" },
        }),
      ]);
      expect(Object.keys(out).sort()).toEqual([
        "contentTypes",
        "handle",
        "platform",
        "tier",
      ]);
    });
  });

  describe("platform keys", () => {
    it.each([
      ["Instagram", "instagram"],
      ["YouTube", "youtube"],
      ["Facebook", "facebook"],
      ["LinkedIn", "linkedin"],
      ["X / Twitter", "x"],
      ["Twitter", "x"],
      ["TikTok", "tiktok"],
      ["  instagram ", "instagram"],
      ["Pinterest Pro", "pinterest_pro"],
      ["", ""],
    ])("%s → %s", (name, key) => {
      expect(derivePlatformKey(name)).toBe(key);
    });
  });

  describe("change detection (for the admin-flag audit note)", () => {
    it("reports handle/tier changes per account, paired by platform", () => {
      const before = [storedInstagram(), storedYoutube()];
      const after = mergeSocialMediaEntries(
        before,
        [
          browserInstagram({ tier: "Macro" }),
          { platform: "YouTube", handle: "creatorchannel", tier: "Nano" },
        ],
        ids,
      );
      expect(socialIdentityChanges(before, after)).toEqual([
        {
          socialAccountId: ID_A,
          platform: "Instagram",
          handleChanged: false,
          tierChanged: true,
          isNew: false,
        },
      ]);
    });
  });
});

describe("restrictedSocialSummary (Search, viewers without social-link access)", () => {
  const full = [
    {
      _id: "x",
      socialAccountId: ID_A,
      platformKey: "instagram",
      platform: "Instagram",
      handle: "secret_handle",
      tier: " Micro ",
      followersCount: 12000,
      contentTypes: [{ name: "Reel", enabled: true, price: 1500 }],
      selfReportedStats: { avgLikes: 10 },
    },
    { platform: "YouTube", handle: "@chan", tier: "Nano" },
  ];

  it("keeps only platform, platformKey and tier — never handle, id, followers, rates or stats", () => {
    const out = restrictedSocialSummary(full);
    expect(out).toEqual([
      { platform: "Instagram", platformKey: "instagram", tier: "Micro" },
      { platform: "YouTube", platformKey: "youtube", tier: "Nano" },
    ]);
    const text = JSON.stringify(out);
    for (const secret of [
      "secret_handle",
      "@chan",
      ID_A,
      "12000",
      "1500",
      "avgLikes",
      "contentTypes",
    ])
      expect(text).not.toContain(secret);
  });

  it("is safe on missing or malformed input", () => {
    expect(restrictedSocialSummary(undefined)).toEqual([]);
    expect(restrictedSocialSummary("x")).toEqual([]);
    expect(restrictedSocialSummary([null, {}, { tier: 5 }])).toEqual([]);
  });

  it("keeps the first entry first, so the primary tier stays the same", () => {
    const out = restrictedSocialSummary([...full].reverse());
    expect(out[0].tier).toBe("Nano");
  });
});
