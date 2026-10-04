import {
  normalizeCampaignMatchInput,
  normalizeCreatorMatchInput,
} from "../matching-inputs/matching-inputs";
import { MatchingInputsService } from "../matching-inputs/matching-inputs.service";
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  buildCampaignEligibilityList,
  parseCampaignEligibilityQuery,
  toEligibilityRow,
} from "./campaign-eligibility";
import { NOT_EVALUATED, evaluateEligibility } from "./eligibility";
import { MatchingEligibilityController } from "./matching-eligibility.controller";
import { MatchingEligibilityService } from "./matching-eligibility.service";

const rawCreator = (id: string, over: Record<string, any> = {}) => ({
  _id: id,
  name: `Creator ${id}`,
  username: `user_${id}`,
  publicId: `TSZ-${id}`,
  status: "accepted",
  isDeleted: false,
  isEmailVerified: true,
  isMobileVerified: true,
  verificationStatus: "approved",
  profileImages: [{ url: "x" }],
  location: { state: "Telangana", district: "Hyderabad" },
  categories: ["Fashion"],
  languages: ["Telugu"],
  socialMedia: [
    {
      socialAccountId: "64b0000000000000000000a1",
      platformKey: "instagram",
      platform: "Instagram",
      handle: "creator",
      tier: "Macro",
      contentTypes: [{ name: "Reel", enabled: true, price: 1500 }],
    },
  ],
  ...over,
});

const rawCampaign = (over: Record<string, any> = {}) => ({
  _id: "camp-1",
  title: "Diwali Reels",
  status: "active",
  campaignMode: "invite_only",
  ownerType: "brand",
  inviteRecipientRole: "influencer",
  platforms: ["Instagram"],
  categories: ["Fashion"],
  socialMedia: [
    {
      platform: "Instagram",
      contentTypes: [{ name: "Reel", enabled: true, price: 1000 }],
    },
  ],
  minInfluencerTier: "Micro",
  targetState: "Telangana",
  targetDistrict: "Hyderabad",
  languages: ["Telugu"],
  ...over,
});

const campaign = normalizeCampaignMatchInput(rawCampaign());
const row = (id: string, over: Record<string, any> = {}) => {
  const raw = rawCreator(id, over);
  return toEligibilityRow(
    evaluateEligibility(
      campaign,
      normalizeCreatorMatchInput(raw, "Influencer"),
    ),
    { name: raw.name, username: raw.username, publicId: raw.publicId },
  );
};

// pass-b, pass-a (sorted by name), unknown (no languages), fail-lang, fail-pending
const rows = () => [
  row("b"),
  row("a"),
  row("u", { languages: [] }),
  row("f1", { languages: ["Hindi"] }),
  row("f2", { verificationStatus: "pending" }),
];

const list = (raw: Record<string, unknown> = {}) =>
  buildCampaignEligibilityList(
    campaign,
    "Diwali Reels",
    "Influencer",
    rows(),
    parseCampaignEligibilityQuery(raw),
    NOT_EVALUATED,
  );

describe("Stage 3B-3 query parsing", () => {
  it("defaults to PASS + UNKNOWN, page 1, default page size", () => {
    expect(parseCampaignEligibilityQuery({})).toEqual({
      statuses: ["PASS", "UNKNOWN"],
      requirement: null,
      search: "",
      page: 1,
      pageSize: DEFAULT_PAGE_SIZE,
    });
  });

  it("accepts status lists, 'all', a requirement key and clamps page size", () => {
    const q = parseCampaignEligibilityQuery({
      status: "fail, unknown",
      requirement: "language",
      q: "  ann ",
      page: "3",
      pageSize: "5000",
    });
    expect(q).toMatchObject({
      statuses: ["UNKNOWN", "FAIL"],
      requirement: "language",
      search: "ann",
      page: 3,
      pageSize: MAX_PAGE_SIZE,
    });
    expect(parseCampaignEligibilityQuery({ status: "all" }).statuses).toEqual([
      "PASS",
      "UNKNOWN",
      "FAIL",
    ]);
  });

  it("ignores unknown statuses, requirement keys and bad numbers", () => {
    expect(
      parseCampaignEligibilityQuery({
        status: "maybe",
        requirement: "trendScore",
        page: "-1",
        pageSize: "abc",
      }),
    ).toMatchObject({
      statuses: ["PASS", "UNKNOWN"],
      requirement: null,
      page: 1,
      pageSize: DEFAULT_PAGE_SIZE,
    });
  });
});

describe("Stage 3B-3 campaign eligibility list", () => {
  it("rows carry status + reason per requirement and no scores", () => {
    const r = row("a");
    expect(r.overall).toBe("PASS");
    expect(Object.keys(r.requirements)).toEqual([
      "accountApproval",
      "creatorType",
      "platformContent",
      "category",
      "minimumTier",
      "location",
      "language",
    ]);
    expect(r.requirements.language).toMatchObject({
      status: "PASS",
      configured: true,
    });
    expect(JSON.stringify(r)).not.toMatch(/score|rank|weight/i);
  });

  it("counts every evaluated creator, unaffected by filters", () => {
    const l = list({ status: "PASS" });
    expect(l.scope).toEqual({
      creatorType: "Influencer",
      evaluated: 5,
      alreadyInvited: 0,
    });
    expect(l.counts).toEqual({ PASS: 2, UNKNOWN: 1, FAIL: 2 });
    expect(l.requirementCounts.language).toEqual({
      PASS: 3,
      UNKNOWN: 1,
      FAIL: 1,
      configured: true,
    });
    expect(l.requirementCounts.accountApproval).toMatchObject({
      PASS: 4,
      FAIL: 1,
    });
  });

  it("defaults to PASS then UNKNOWN; deterministic order by group, name, id", () => {
    const l = list();
    expect(l.total).toBe(3);
    expect(l.rows.map((r) => r.creatorId)).toEqual(["a", "b", "u"]);
    expect(list({ status: "all" }).rows.map((r) => r.overall)).toEqual([
      "PASS",
      "PASS",
      "UNKNOWN",
      "FAIL",
      "FAIL",
    ]);
  });

  it("requirement filter keeps rows where that requirement is FAIL or UNKNOWN", () => {
    const l = list({ status: "all", requirement: "language" });
    expect(l.rows.map((r) => r.creatorId)).toEqual(["u", "f1"]);
  });

  it("searches name, username, public id and id", () => {
    expect(
      list({ status: "all", q: "TSZ-F2" }).rows.map((r) => r.creatorId),
    ).toEqual(["f2"]);
    expect(list({ status: "all", q: "user_b" }).total).toBe(1);
  });

  it("paginates after filtering", () => {
    const l = list({ status: "all", pageSize: "2", page: "2" });
    expect(l.total).toBe(5);
    expect(l.rows.map((r) => r.creatorId)).toEqual(["u", "f1"]);
  });

  it("describes the campaign's configured requirements", () => {
    expect(list().campaign).toEqual({
      campaignId: "camp-1",
      title: "Diwali Reels",
      status: "active",
      recipientRole: "influencer",
      ownerType: "brand",
      requirements: {
        platforms: ["instagram"],
        contentTypes: ["instagram:reel"],
        categories: ["Fashion"],
        targetCreatorCategories: [],
        minimumTier: "Micro",
        location: { state: "Telangana", district: "Hyderabad" },
        languages: ["Telugu"],
      },
    });
  });
});

describe("Stage 3B-3 service / controller", () => {
  const invites = {
    invitedRecipientIds: jest.fn().mockResolvedValue(new Set(["f1"])),
  };
  it("evaluates every creator of the recipient type through the 3B-2 evaluator", async () => {
    const inputs = {
      forCampaignWithTitle: jest
        .fn()
        .mockResolvedValue({ input: campaign, title: "Diwali Reels" }),
      forAllCreators: jest.fn().mockResolvedValue(
        ["a", "f1"].map((id) => {
          const raw = rawCreator(
            id,
            id === "f1" ? { languages: ["Hindi"] } : {},
          );
          return {
            input: normalizeCreatorMatchInput(raw, "Influencer"),
            display: {
              name: raw.name,
              username: raw.username,
              publicId: raw.publicId,
            },
          };
        }),
      ),
    };
    const l = await new MatchingEligibilityService(
      inputs as any,
      invites as any,
    ).evaluateCampaign("camp-1", { status: "all" });
    expect(inputs.forCampaignWithTitle).toHaveBeenCalledWith("camp-1");
    expect(inputs.forAllCreators).toHaveBeenCalledWith("Influencer");
    expect(l.counts).toEqual({ PASS: 1, UNKNOWN: 0, FAIL: 1 });
    // Stage 3B-4: rows say whether the creator already holds an invite.
    expect(invites.invitedRecipientIds).toHaveBeenCalledWith("camp-1");
    expect(l.rows.map((r) => [r.creatorId, r.invited])).toEqual([
      ["a", false],
      ["f1", true],
    ]);
    expect(l.scope.alreadyInvited).toBe(1);
  });

  it("photographer-recipient campaigns evaluate photographers", async () => {
    const inputs = {
      forCampaignWithTitle: jest.fn().mockResolvedValue({
        input: normalizeCampaignMatchInput(
          rawCampaign({ inviteRecipientRole: "photographer" }),
        ),
        title: "Shoot",
      }),
      forAllCreators: jest.fn().mockResolvedValue([]),
    };
    const l = await new MatchingEligibilityService(
      inputs as any,
      invites as any,
    ).evaluateCampaign("camp-1");
    expect(inputs.forAllCreators).toHaveBeenCalledWith("Photographer");
    expect(l.scope).toEqual({
      creatorType: "Photographer",
      evaluated: 0,
      alreadyInvited: 0,
    });
  });

  it("is GET admin/matching/eligibility/:campaignId", () => {
    expect(
      Reflect.getMetadata(
        "path",
        Object.getOwnPropertyDescriptor(
          MatchingEligibilityController.prototype,
          "campaignEligibility",
        )?.value,
      ),
    ).toBe("eligibility/:campaignId");
  });

  it("forAllCreators: one read of non-deleted profiles, no password, no evidence calls", async () => {
    const lean = jest.fn().mockResolvedValue([rawCreator("a")]);
    const select = jest.fn().mockReturnValue({ lean });
    const find = jest.fn().mockReturnValue({ select });
    const verification = { listForProfile: jest.fn() };
    const observation = { listForProfile: jest.fn() };
    const service = new MatchingInputsService(
      { find } as any,
      { find: jest.fn() } as any,
      {} as any,
      verification as any,
      observation as any,
    );
    const out = await service.forAllCreators("Influencer");
    expect(find).toHaveBeenCalledWith({ isDeleted: { $ne: true } });
    expect(select).toHaveBeenCalledWith("-password");
    expect(verification.listForProfile).not.toHaveBeenCalled();
    expect(observation.listForProfile).not.toHaveBeenCalled();
    expect(out[0].display).toEqual({
      name: "Creator a",
      username: "user_a",
      publicId: "TSZ-a",
    });
    expect(out[0].input.eligibility.approvedActiveAccount).toBe(true);
  });
});
