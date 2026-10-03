import { CampaignsService } from "./campaigns.service";

/**
 * Stage 3B-1 — campaign requirement fields (validation on save) and the
 * open-campaign alert matcher (approval rule + canonical platform/tier).
 */
function makeService(
  overrides: {
    influencerModel?: any;
    photographerModel?: any;
    campaignModel?: any;
  } = {},
) {
  const notificationsService = {
    createForUser: jest.fn().mockResolvedValue({}),
  };
  const pushService = { sendToUser: jest.fn().mockResolvedValue({}) };
  const whatsAppService = { sendToUser: jest.fn().mockResolvedValue({}) };
  const args: any[] = [
    overrides.campaignModel ?? {}, // campaignModel
    { countDocuments: jest.fn().mockResolvedValue(0) }, // campaignInviteModel
    {
      findById: jest.fn(() => ({
        select: () => ({ lean: () => Promise.resolve({ brandName: "Acme" }) }),
      })),
    }, // brandModel
    overrides.photographerModel ?? {}, // photographerModel
    overrides.influencerModel ?? {}, // influencerModel
    {}, // appSettingsModel
    {
      find: jest.fn(() => ({
        select: () => ({ lean: () => Promise.resolve([]) }),
      })),
    }, // profileFlagModel
    {}, // counterModel
    {}, // plansService
    {}, // cloudinaryService
    pushService,
    notificationsService,
    whatsAppService,
    {}, // profileVerificationService
    {}, // campaignInvitesService
    {}, // platformEvents
  ];
  const service = new (CampaignsService as any)(...args) as CampaignsService;
  return { service: service as any, notificationsService };
}

describe("campaign requirement fields on save (Stage 3B-1)", () => {
  const normalize = (data: any) =>
    makeService().service.normalizeCampaignPayload(data, {});

  it("minimum tier: optional, validated and stored as the canonical label", () => {
    expect(normalize({ minInfluencerTier: "mid tier" }).minInfluencerTier).toBe(
      "Mid-Tier",
    );
    expect(
      normalize({ minInfluencerTier: "Micro (1,001-10,000)" })
        .minInfluencerTier,
    ).toBe("Micro");
    expect(
      normalize({ minInfluencerTier: "" }).minInfluencerTier,
    ).toBeUndefined();
    expect("minInfluencerTier" in normalize({ title: "x" })).toBe(false); // absent stays absent
    expect(() => normalize({ minInfluencerTier: "Gold" })).toThrow(
      "minInfluencerTier must be one of",
    );
  });

  it("target tiers: canonicalized and de-duplicated; non-tier values kept (photographer category reuse)", () => {
    expect(
      normalize({ targetTiers: ["micro", "Micro", "Mid tier", ""] })
        .targetTiers,
    ).toEqual(["Micro", "Mid-Tier"]);
    expect(
      normalize({ targetTiers: ["Fashion", "Beauty"] }).targetTiers,
    ).toEqual(["Fashion", "Beauty"]);
  });

  it("languages: optional list, trimmed and de-duplicated; absent stays absent", () => {
    expect(
      normalize({ languages: [" Telugu", "telugu", "English", ""] }).languages,
    ).toEqual(["Telugu", "English"]);
    expect(normalize({ languages: null }).languages).toEqual([]);
    expect("languages" in normalize({ title: "x" })).toBe(false);
    expect(() => normalize({ languages: "Telugu" })).toThrow(
      "languages must be a list",
    );
  });

  it("languages must exist in the languages master list (stored with its spelling)", async () => {
    const distinct = jest
      .fn()
      .mockResolvedValue(["English", "Telugu", "Hindi"]);
    const { service } = makeService({
      campaignModel: { db: { collection: () => ({ distinct }) } },
    });
    const ok: any = { languages: ["telugu", "ENGLISH"] };
    await service.assertCampaignLanguages(ok);
    expect(ok.languages).toEqual(["Telugu", "English"]);
    await expect(
      service.assertCampaignLanguages({ languages: ["Klingon"] }),
    ).rejects.toThrow("Unknown language(s): Klingon");
    // No languages → no lookup at all.
    distinct.mockClear();
    await service.assertCampaignLanguages({});
    expect(distinct).not.toHaveBeenCalled();
  });
});

describe("notifyMatchingInfluencers (Stage 3B-1 corrections)", () => {
  function run(campaign: any, candidates: any[]) {
    const find = jest.fn(() => ({
      select: () => ({
        limit: () => ({ lean: () => Promise.resolve(candidates) }),
      }),
    }));
    const { service, notificationsService } = makeService({
      influencerModel: { find },
      photographerModel: {
        find,
        findById: () => ({
          select: () => ({ lean: () => Promise.resolve(null) }),
        }),
      },
    });
    return service
      .notifyMatchingInfluencers({
        _id: "c1",
        title: "T",
        brandId: "b1",
        ...campaign,
      })
      .then(() => ({
        query: (find.mock.calls[0] as any[] | undefined)?.[0],
        notified: notificationsService.createForUser.mock.calls.map(
          (c: any[]) => c[0].userId,
        ),
      }));
  }
  const sm = (platform: string, tier: string, platformKey?: string) => ({
    platform,
    tier,
    ...(platformKey ? { platformKey } : {}),
  });

  it("only queries active, admin-approved accounts (pending/rejected/deleted/suspended excluded)", async () => {
    const { query } = await run({ categories: ["Fashion"] }, []);
    expect(query).toMatchObject({
      status: "accepted",
      isDeleted: { $ne: true },
      isEmailVerified: true,
      isMobileVerified: true,
      email: { $exists: true, $ne: "" },
      categories: { $in: ["Fashion"] },
    });
    expect(query.$and).toEqual(
      expect.arrayContaining([
        {
          $or: [
            { verificationStatus: "approved" },
            { verifiedByTrendStarz: true },
          ],
        },
        {
          $or: [
            { accountStatus: { $exists: false } },
            { accountStatus: { $nin: ["suspended", "SUSPENDED"] } },
          ],
        },
      ]),
    );
  });

  it("matches platforms by canonical platformKey (display name kept as a fallback)", async () => {
    const { query } = await run(
      { platforms: ["Instagram", "X / Twitter"] },
      [],
    );
    expect(query.socialMedia).toEqual({
      $elemMatch: {
        $or: [
          { platformKey: { $in: ["instagram", "x"] } },
          { platform: { $in: ["Instagram", "X / Twitter"] } },
        ],
      },
    });
  });

  it("location stays an exact state/district filter (unchanged)", async () => {
    const { query } = await run(
      { targetState: "Telangana", targetDistrict: "Hyderabad" },
      [],
    );
    expect(query).toMatchObject({
      "location.state": "Telangana",
      "location.district": "Hyderabad",
    });
  });

  it("tier filter compares canonical tiers on the campaign's platforms only", async () => {
    const { notified } = await run(
      { platforms: ["Instagram"], minInfluencerTier: "Micro" },
      [
        { _id: "a", socialMedia: [sm("instagram", "Mid tier", "instagram")] }, // spelling variant ≥ Micro → yes
        { _id: "b", socialMedia: [sm("Instagram", "Nano")] }, // below
        { _id: "c", socialMedia: [sm("YouTube", "Macro", "youtube")] }, // wrong platform
        { _id: "d", socialMedia: [sm("Instagram", "Micro", "instagram")] }, // exactly Micro
      ],
    );
    expect(notified).toEqual(["a", "d"]);
  });

  it("target tiers compare by canonical key", async () => {
    const { notified } = await run(
      { platforms: ["Instagram"], targetTiers: ["Mid-Tier"] },
      [
        { _id: "a", socialMedia: [sm("Instagram", "mid tier")] },
        { _id: "b", socialMedia: [sm("Instagram", "Micro")] },
      ],
    );
    expect(notified).toEqual(["a"]);
  });

  it("no filters at all → no alerts (unchanged guard)", async () => {
    const { query, notified } = await run({}, [{ _id: "a", socialMedia: [] }]);
    expect(query).toBeUndefined();
    expect(notified).toEqual([]);
  });
});

describe("T1 — campaign target district is stored in targetDistrict (Stage 3B-1)", () => {
  const states = ["Telangana", "Andhra Pradesh"];
  const districts = [
    { name: "Hyderabad", state: "Telangana" },
    { name: "Warangal", state: "Telangana" },
    { name: "Guntur", state: "Andhra Pradesh" },
  ];
  function locationService() {
    const distinct = jest.fn().mockResolvedValue(states);
    const find = jest.fn(() => ({ toArray: () => Promise.resolve(districts) }));
    const collection = jest.fn(() => ({ distinct, find }));
    const { service } = makeService({ campaignModel: { db: { collection } } });
    const save = async (data: any, existing?: any) => {
      const normalized = service.normalizeCampaignPayload(data, {});
      await service.assertCampaignTargetLocation(normalized, existing);
      return normalized;
    };
    return { save, collection };
  }

  it("a newly selected district persists to targetDistrict, with the master spelling", async () => {
    const { save } = locationService();
    const n = await save({
      targetState: "telangana",
      targetDistrict: "HYDERABAD",
      targetCities: ["HYDERABAD"],
    });
    expect(n.targetState).toBe("Telangana");
    expect(n.targetDistrict).toBe("Hyderabad");
    expect(n.targetCities).toEqual(["HYDERABAD"]); // legacy mirror passes through untouched
  });

  it("on edit, a district is checked against the campaign's stored state when the payload has no state", async () => {
    const { save } = locationService();
    expect(
      (await save({ targetDistrict: "Warangal" }, { targetState: "Telangana" }))
        .targetDistrict,
    ).toBe("Warangal");
  });

  it("rejects an unknown state, an unknown district, a district from another state, or a district without a state", async () => {
    const { save } = locationService();
    await expect(save({ targetState: "Atlantis" })).rejects.toThrow(
      "Unknown targetState",
    );
    await expect(
      save({ targetState: "Telangana", targetDistrict: "Gotham" }),
    ).rejects.toThrow("Unknown targetDistrict for Telangana");
    await expect(
      save({ targetState: "Telangana", targetDistrict: "Guntur" }),
    ).rejects.toThrow("Unknown targetDistrict");
    await expect(save({ targetDistrict: "Hyderabad" })).rejects.toThrow(
      "targetDistrict requires targetState",
    );
  });

  it("clearing the state clears the district and its legacy mirror", async () => {
    const { save } = locationService();
    const n = await save({
      targetState: "",
      targetDistrict: "Hyderabad",
      targetCities: ["Hyderabad"],
    });
    expect(n.targetState).toBeUndefined();
    expect(n.targetDistrict).toBeUndefined();
    expect(n.targetCities).toEqual([]);
  });

  it("an empty district clears it; saves that don't touch location do no lookups and change nothing", async () => {
    const { save, collection } = locationService();
    const cleared = await save({
      targetState: "Telangana",
      targetDistrict: "",
    });
    expect(cleared.targetDistrict).toBeUndefined();
    collection.mockClear();
    const untouched = await save({ title: "Spring drop" });
    expect(collection).not.toHaveBeenCalled();
    expect("targetDistrict" in untouched || "targetState" in untouched).toBe(
      false,
    );
  });
});

describe("alert matcher excludes every non-approved status (query evaluated, not just inspected)", () => {
  /** Tiny evaluator for the operators the approval filter uses. */
  function matches(doc: any, filter: any): boolean {
    return Object.entries(filter).every(([key, cond]: [string, any]) => {
      if (key === "$and") return cond.every((c: any) => matches(doc, c));
      if (key === "$or") return cond.some((c: any) => matches(doc, c));
      const value = key
        .split(".")
        .reduce((v: any, k) => (v == null ? undefined : v[k]), doc);
      if (cond && typeof cond === "object" && !Array.isArray(cond)) {
        return Object.entries(cond).every(([op, arg]: [string, any]) => {
          if (op === "$ne") return value !== arg;
          if (op === "$in") return arg.includes(value);
          if (op === "$nin") return !arg.includes(value);
          if (op === "$exists") return (value !== undefined) === arg;
          throw new Error(`unsupported operator ${op}`);
        });
      }
      return value === cond;
    });
  }

  it.each([
    ["approved & active", {}, true],
    ["pending review", { verificationStatus: "pending" }, false],
    ["rejected", { verificationStatus: "rejected" }, false],
    ["unaccepted", { status: "pending" }, false],
    ["deleted", { isDeleted: true }, false],
    ["suspended", { accountStatus: "suspended" }, false],
    ["suspended (upper case)", { accountStatus: "SUSPENDED" }, false],
    [
      "approved via verifiedByTrendStarz",
      { verificationStatus: "pending", verifiedByTrendStarz: true },
      true,
    ],
  ])("%s → alerted: %s", async (_label, over, expected) => {
    const find = jest.fn(() => ({
      select: () => ({ limit: () => ({ lean: () => Promise.resolve([]) }) }),
    }));
    const { service } = makeService({ influencerModel: { find } });
    await service.notifyMatchingInfluencers({
      _id: "c1",
      title: "T",
      brandId: "b1",
      categories: ["Fashion"],
    });
    const query = (find.mock.calls[0] as any[])[0];
    const creator = {
      email: "c@example.com",
      status: "accepted",
      isDeleted: false,
      isEmailVerified: true,
      isMobileVerified: true,
      verificationStatus: "approved",
      categories: ["Fashion"],
      ...over,
    };
    // categories $in is covered by the matcher tests above.
    const approvalQuery = { ...query };
    delete approvalQuery.categories;
    expect(matches(creator, approvalQuery)).toBe(expected);
  });
});
