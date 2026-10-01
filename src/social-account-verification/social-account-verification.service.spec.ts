import mongoose from "mongoose";
import { SocialAccountReviewSchema } from "../database/schemas/social-account-verification.schema";
import {
  SocialAccountVerificationService,
  effectiveDecision,
  toSocialProfileType,
} from "./social-account-verification.service";

// ── In-memory stand-ins for the two collections (only what the service uses) ──
const clone = <T>(v: T): T =>
  v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
const reviveDates = (doc: any) => {
  for (const rt of ["ownership", "tier"]) {
    for (const k of ["decidedAt", "invalidatedAt"]) {
      if (doc?.[rt]?.[k]) doc[rt][k] = new Date(doc[rt][k]);
    }
  }
  return doc;
};
function getPath(doc: any, path: string) {
  return path.split(".").reduce((v, k) => (v == null ? undefined : v[k]), doc);
}
function matches(doc: any, filter: any) {
  return Object.entries(filter).every(([path, cond]: [string, any]) => {
    const v = getPath(doc, path);
    if (cond && typeof cond === "object" && "$in" in cond)
      return cond.$in.includes(v);
    if (cond instanceof Date)
      return v instanceof Date && v.getTime() === cond.getTime();
    return v === cond;
  });
}
const lean = (value: any) => ({
  lean: () => Promise.resolve(value),
  select: () => ({ lean: () => Promise.resolve(value) }),
});

function setup(
  opts: {
    admins?: Record<string, any>;
    states?: any[];
  } = {},
) {
  let seq = 0;
  const states: any[] = (opts.states || []).map((s) =>
    reviveDates({ _id: `s${++seq}`, ...clone(s) }),
  );
  const reviews: any[] = [];
  const stateModel = {
    findOne: jest.fn((f: any) =>
      lean(reviveDates(clone(states.find((d) => matches(d, f))) ?? null)),
    ),
    find: jest.fn((f: any) =>
      lean(
        states.filter((d) => matches(d, f)).map((d) => reviveDates(clone(d))),
      ),
    ),
    findOneAndUpdate: jest.fn((f: any, update: any) => {
      let doc = states.find((d) => matches(d, f));
      if (!doc) {
        doc = { _id: `s${++seq}`, ...f };
        states.push(doc);
      }
      Object.assign(doc, clone(update.$set));
      reviveDates(doc);
      return lean(reviveDates(clone(doc)));
    }),
    updateOne: jest.fn((f: any, update: any) => {
      const doc = states.find((d) => matches(d, f));
      if (!doc) return Promise.resolve({ modifiedCount: 0 });
      Object.assign(doc, clone(update.$set));
      reviveDates(doc);
      return Promise.resolve({ modifiedCount: 1 });
    }),
  };
  const reviewModel = {
    create: jest.fn((doc: any) => {
      reviews.push(doc);
      return Promise.resolve(doc);
    }),
  };
  const admins = opts.admins ?? {
    "admin-1": { name: "Asha Admin", email: "asha@trendstarz.in" },
  };
  const userModel = {
    findById: jest.fn((id: string) => lean(admins[id] ?? null)),
  };
  const service = new SocialAccountVerificationService(
    stateModel as any,
    reviewModel as any,
    userModel as any,
  );
  return { service, states, reviews, stateModel, reviewModel };
}

const ID_A = "64b0000000000000000000a1";
const ID_B = "64b0000000000000000000b2";
const admin = { role: "admin", userId: "admin-1", email: "asha@trendstarz.in" };
const instagram = () => ({
  socialAccountId: ID_A,
  platformKey: "instagram",
  platform: "Instagram",
  handle: "creator",
  tier: "Mid-Tier",
  followersCount: 0,
  contentTypes: [{ name: "Reel", price: 500 }],
});
const youtube = () => ({
  socialAccountId: ID_B,
  platformKey: "youtube",
  platform: "YouTube",
  handle: "creatortube",
  tier: "Micro",
  followersCount: 0,
});
const base = { profileType: "Influencer" as const, profileId: "inf-1" };

describe("SocialAccountVerificationService (Stage 3A-1)", () => {
  describe("ownership decisions", () => {
    it("verifies the exact account and records the reviewed handle, admin and time from the server", async () => {
      const { service, states, reviews } = setup();
      const before = Date.now();
      const account = await service.decide(admin, {
        ...base,
        entry: instagram(),
        reviewType: "ownership",
        body: { status: "verified", note: "  Manually reviewed  " },
      });

      expect(account.ownershipVerification).toMatchObject({
        status: "verified",
        method: "manual",
        decidedHandle: "creator",
        decidedById: "admin-1",
        decidedByName: "Asha Admin",
        decidedByRole: "admin",
        note: "Manually reviewed",
      });
      const decidedAt = account.ownershipVerification.decidedAt as Date;
      expect(decidedAt).toBeInstanceOf(Date);
      expect(decidedAt.getTime()).toBeGreaterThanOrEqual(before);
      expect(account.tierVerification).toEqual({ status: "pending" });

      expect(states).toHaveLength(1);
      expect(states[0]).toMatchObject({
        profileType: "Influencer",
        profileId: "inf-1",
        socialAccountId: ID_A,
        platformKey: "instagram",
      });
      expect(states[0].tier).toBeUndefined();

      expect(reviews).toEqual([
        {
          socialAccountId: ID_A,
          profileId: "inf-1",
          profileType: "Influencer",
          platformKey: "instagram",
          platform: "Instagram",
          handle: "creator",
          declaredTier: "Mid-Tier",
          reviewType: "ownership",
          previousStatus: "pending",
          newStatus: "verified",
          method: "manual",
          decidedAt,
          decidedById: "admin-1",
          decidedByName: "Asha Admin",
          decidedByRole: "admin",
          note: "Manually reviewed",
        },
      ]);
    });

    it("rejects the exact account", async () => {
      const { service, reviews } = setup();
      const account = await service.decide(admin, {
        ...base,
        entry: instagram(),
        reviewType: "ownership",
        body: { status: "rejected", note: "Unable to verify ownership" },
      });
      expect(account.ownershipVerification).toMatchObject({
        status: "rejected",
        decidedHandle: "creator",
        note: "Unable to verify ownership",
      });
      expect(reviews[0]).toMatchObject({
        previousStatus: "pending",
        newStatus: "rejected",
      });
    });

    it("ignores every client-supplied decision field", async () => {
      const { service, states } = setup();
      await service.decide(admin, {
        ...base,
        entry: instagram(),
        reviewType: "ownership",
        body: {
          status: "verified",
          decidedHandle: "someone.else",
          decidedTier: "Mega / Celebrity",
          decidedAt: "2020-01-01T00:00:00.000Z",
          decidedById: "attacker",
          decidedByName: "Attacker",
          method: "api",
        } as any,
      });
      const o = states[0].ownership;
      expect(o).toMatchObject({
        method: "manual",
        decidedHandle: "creator",
        decidedById: "admin-1",
        decidedByName: "Asha Admin",
      });
      expect(o.decidedTier).toBeUndefined();
      expect(o.decidedAt.getFullYear()).not.toBe(2020);
    });

    it("allows subadmins and records their role; falls back to the token email when the admin has no name", async () => {
      const { service, states } = setup({ admins: {} });
      await service.decide(
        { role: "subadmin", userId: "sub-9", email: "sub@trendstarz.in" },
        {
          ...base,
          entry: instagram(),
          reviewType: "ownership",
          body: { status: "verified" },
        },
      );
      expect(states[0].ownership).toMatchObject({
        decidedById: "sub-9",
        decidedByName: "sub@trendstarz.in",
        decidedByRole: "subadmin",
        note: "",
      });
    });
  });

  describe("tier decisions", () => {
    it("verifies the declared tier as a snapshot without touching the account", async () => {
      const { service, reviews } = setup();
      const entry = instagram();
      const original = clone(entry);
      const account = await service.decide(admin, {
        ...base,
        entry,
        reviewType: "tier",
        body: {
          status: "verified",
          note: "Tier reviewed against declared range",
        },
      });
      expect(account.tier).toBe("Mid-Tier");
      expect(account.tierVerification).toMatchObject({
        status: "verified",
        method: "manual",
        decidedTier: "Mid-Tier",
        decidedById: "admin-1",
      });
      expect(account.tierVerification.decidedHandle).toBeUndefined();
      // Tier verification never verifies ownership, and never rewrites the account.
      expect(account.ownershipVerification).toEqual({ status: "pending" });
      expect(entry).toEqual(original);
      expect(reviews[0]).toMatchObject({
        reviewType: "tier",
        declaredTier: "Mid-Tier",
        newStatus: "verified",
      });
    });

    it("rejects the declared tier", async () => {
      const { service } = setup();
      const account = await service.decide(admin, {
        ...base,
        entry: instagram(),
        reviewType: "tier",
        body: {
          status: "rejected",
          note: "Declared tier could not be verified",
        },
      });
      expect(account.tierVerification).toMatchObject({
        status: "rejected",
        decidedTier: "Mid-Tier",
      });
    });

    it("keeps ownership and tier independent on the same account", async () => {
      const { service } = setup();
      await service.decide(admin, {
        ...base,
        entry: instagram(),
        reviewType: "ownership",
        body: { status: "verified" },
      });
      const account = await service.decide(admin, {
        ...base,
        entry: instagram(),
        reviewType: "tier",
        body: { status: "rejected" },
      });
      expect(account.ownershipVerification.status).toBe("verified");
      expect(account.tierVerification.status).toBe("rejected");
    });
  });

  describe("isolation between accounts", () => {
    it("verifying Instagram and rejecting YouTube affect only those accounts", async () => {
      const { service } = setup();
      await service.decide(admin, {
        ...base,
        entry: instagram(),
        reviewType: "ownership",
        body: { status: "verified" },
      });
      let list = await service.listForProfile("Influencer", "inf-1", [
        instagram(),
        youtube(),
      ]);
      expect(list.map((a) => a.ownershipVerification.status)).toEqual([
        "verified",
        "pending",
      ]);

      await service.decide(admin, {
        ...base,
        entry: youtube(),
        reviewType: "ownership",
        body: { status: "rejected" },
      });
      list = await service.listForProfile("Influencer", "inf-1", [
        instagram(),
        youtube(),
      ]);
      expect(list.map((a) => a.ownershipVerification.status)).toEqual([
        "verified",
        "rejected",
      ]);
      expect(list.map((a) => a.tierVerification.status)).toEqual([
        "pending",
        "pending",
      ]);
    });

    it("never reads another profile's decision for the same account id", async () => {
      const { service } = setup({
        states: [
          {
            profileType: "Influencer",
            profileId: "someone-else",
            socialAccountId: ID_A,
            ownership: { status: "verified", decidedHandle: "creator" },
          },
        ],
      });
      const [a] = await service.listForProfile("Influencer", "inf-1", [
        instagram(),
      ]);
      expect(a.ownershipVerification).toEqual({ status: "pending" });
    });
  });

  describe("validation and authorization", () => {
    const decide = (
      svc: SocialAccountVerificationService,
      actor: any,
      body: any,
      entry: any = instagram(),
    ) => svc.decide(actor, { ...base, entry, reviewType: "ownership", body });

    it.each([
      [{ role: "influencer", userId: "inf-1" }],
      [{ role: "brand", userId: "b-1" }],
      [undefined],
    ])("refuses non-admin actors (%j)", async (actor) => {
      const { service, states, reviews } = setup();
      await expect(
        decide(service, actor, { status: "verified" }),
      ).rejects.toThrow("Admin access only");
      expect(states).toHaveLength(0);
      expect(reviews).toHaveLength(0);
    });

    it.each(["pending", "approved", "", undefined, true])(
      "refuses status %p",
      async (status) => {
        const { service, states } = setup();
        await expect(decide(service, admin, { status })).rejects.toThrow(
          /status must be/,
        );
        expect(states).toHaveLength(0);
      },
    );

    it("refuses a non-text or over-long note", async () => {
      const { service } = setup();
      await expect(
        decide(service, admin, { status: "verified", note: { a: 1 } }),
      ).rejects.toThrow(/note must be text/);
      await expect(
        decide(service, admin, { status: "verified", note: "x".repeat(1001) }),
      ).rejects.toThrow(/at most 1000/);
    });

    it("refuses an account without a valid socialAccountId", async () => {
      const { service } = setup();
      await expect(
        decide(
          service,
          admin,
          { status: "verified" },
          { platform: "Instagram", handle: "x" },
        ),
      ).rejects.toThrow("Invalid social account id");
    });

    it("rejects unsupported profile types", () => {
      expect(toSocialProfileType("influencer")).toBe("Influencer");
      expect(toSocialProfileType("PHOTOGRAPHER")).toBe("Photographer");
      expect(() => toSocialProfileType("admin")).toThrow(
        "Unsupported user type",
      );
    });
  });

  describe("stale-view guard (expectedHandle / expectedTier)", () => {
    it("returns 409 and writes nothing when the handle changed since the admin loaded it", async () => {
      const { service, states, reviews } = setup();
      const err = await service
        .decide(admin, {
          ...base,
          entry: { ...instagram(), handle: "renamed" },
          reviewType: "ownership",
          body: { status: "verified", expectedHandle: "creator" },
        })
        .catch((e) => e);
      expect(err.getStatus()).toBe(409);
      expect(states).toHaveLength(0);
      expect(reviews).toHaveLength(0);
    });

    it("returns 409 when the declared tier changed", async () => {
      const { service } = setup();
      const err = await service
        .decide(admin, {
          ...base,
          entry: instagram(),
          reviewType: "tier",
          body: { status: "verified", expectedTier: "Micro" },
        })
        .catch((e) => e);
      expect(err.getStatus()).toBe(409);
    });

    it("treats '@', case and tier spelling differences as the same value", async () => {
      const { service } = setup();
      await expect(
        service.decide(admin, {
          ...base,
          entry: instagram(),
          reviewType: "ownership",
          body: { status: "verified", expectedHandle: "@Creator" },
        }),
      ).resolves.toBeDefined();
      await expect(
        service.decide(admin, {
          ...base,
          entry: instagram(),
          reviewType: "tier",
          body: { status: "verified", expectedTier: "Mid tier" },
        }),
      ).resolves.toBeDefined();
    });
  });

  describe("invalidation on handle / tier change (reconcile)", () => {
    const verifiedAt = new Date("2026-09-01T10:00:00.000Z");
    const decided = (extra: any) => ({
      method: "manual",
      decidedAt: verifiedAt,
      decidedById: "admin-1",
      decidedByName: "Asha Admin",
      decidedByRole: "admin",
      note: "",
      ...extra,
    });
    const stateFor = (ownership: any, tier?: any) => ({
      profileType: "Influencer",
      profileId: "inf-1",
      socialAccountId: ID_A,
      platformKey: "instagram",
      ownership,
      tier,
    });

    it("a handle change resets ownership to pending, keeps the old decision, and logs it", async () => {
      const { service, states, reviews } = setup({
        states: [
          stateFor(
            decided({ status: "verified", decidedHandle: "old" }),
            decided({ status: "verified", decidedTier: "Mid-Tier" }),
          ),
        ],
      });
      const n = await service.reconcile("Influencer", "inf-1", [
        { ...instagram(), handle: "new" },
      ]);
      expect(n).toBe(1);

      const o = states[0].ownership;
      expect(o).toMatchObject({
        status: "pending",
        invalidatedReason: "handle_changed",
        lastDecision: { status: "verified", decidedHandle: "old" },
      });
      // The old decision is no longer presented as current.
      expect(o.decidedHandle).toBeUndefined();
      expect(o.decidedAt).toBeUndefined();
      // Tier untouched.
      expect(states[0].tier.status).toBe("verified");

      expect(reviews).toEqual([
        expect.objectContaining({
          reviewType: "ownership",
          previousStatus: "verified",
          newStatus: "pending",
          method: "invalidated",
          handle: "new",
          decidedById: "SYSTEM",
          note: "Handle changed from @old to @new",
        }),
      ]);
    });

    it("a rejected ownership is also reset on handle change", async () => {
      const { service, states } = setup({
        states: [
          stateFor(decided({ status: "rejected", decidedHandle: "old" })),
        ],
      });
      await service.reconcile("Influencer", "inf-1", [
        { ...instagram(), handle: "new" },
      ]);
      expect(states[0].ownership.status).toBe("pending");
      expect(states[0].ownership.lastDecision.status).toBe("rejected");
    });

    it("a tier change resets tier to pending (never auto-verifies the new tier) and leaves ownership", async () => {
      const { service, states, reviews } = setup({
        states: [
          stateFor(
            decided({ status: "verified", decidedHandle: "creator" }),
            decided({ status: "verified", decidedTier: "Micro" }),
          ),
        ],
      });
      await service.reconcile("Influencer", "inf-1", [instagram()]); // now Mid-Tier
      expect(states[0].tier).toMatchObject({
        status: "pending",
        invalidatedReason: "tier_changed",
        lastDecision: { decidedTier: "Micro" },
      });
      expect(states[0].ownership.status).toBe("verified");
      expect(reviews).toHaveLength(1);
      expect(reviews[0]).toMatchObject({
        reviewType: "tier",
        declaredTier: "Mid-Tier",
        note: "Declared tier changed from Micro to Mid-Tier",
      });
    });

    it("does nothing when handle and tier are unchanged (including '@', case and tier spelling)", async () => {
      const { service, stateModel, reviews } = setup({
        states: [
          stateFor(
            decided({ status: "verified", decidedHandle: "@Creator" }),
            decided({ status: "verified", decidedTier: "Mid tier" }),
          ),
        ],
      });
      expect(
        await service.reconcile("Influencer", "inf-1", [instagram()]),
      ).toBe(0);
      expect(stateModel.updateOne).not.toHaveBeenCalled();
      expect(reviews).toHaveLength(0);
    });

    it("changing the handle back does not restore the old verification", async () => {
      const { service, states } = setup({
        states: [
          stateFor(decided({ status: "verified", decidedHandle: "creator" })),
        ],
      });
      await service.reconcile("Influencer", "inf-1", [
        { ...instagram(), handle: "other" },
      ]);
      await service.reconcile("Influencer", "inf-1", [instagram()]);
      const [a] = await service.listForProfile("Influencer", "inf-1", [
        instagram(),
      ]);
      expect(a.ownershipVerification.status).toBe("pending");
      expect(states[0].ownership.status).toBe("pending");
    });

    it("never overwrites a newer admin decision that landed after it read the state", async () => {
      const { service, states, stateModel, reviews } = setup({
        states: [
          stateFor(decided({ status: "verified", decidedHandle: "old" })),
        ],
      });
      // An admin re-verifies (new decidedAt) between reconcile's read and write.
      const staleRead = [reviveDates(clone(states[0]))];
      states[0].ownership = decided({
        status: "verified",
        decidedHandle: "new",
        decidedAt: new Date("2026-09-02T10:00:00.000Z"),
      });
      stateModel.find.mockReturnValueOnce(lean(staleRead));
      expect(
        await service.reconcile("Influencer", "inf-1", [
          { ...instagram(), handle: "new" },
        ]),
      ).toBe(0);
      expect(states[0].ownership).toMatchObject({
        status: "verified",
        decidedHandle: "new",
      });
      expect(reviews).toHaveLength(0);
    });

    it("logs and swallows failures (the profile save already succeeded)", async () => {
      const { service, stateModel } = setup();
      stateModel.find.mockImplementationOnce(() => {
        throw new Error("db down");
      });
      const log = jest
        .spyOn((service as any).logger, "error")
        .mockImplementation(() => undefined);
      await expect(
        service.reconcile("Influencer", "inf-1", [instagram()]),
      ).resolves.toBe(0);
      expect(log).toHaveBeenCalled();
    });

    it("ignores entries without a socialAccountId", async () => {
      const { service, stateModel } = setup();
      expect(
        await service.reconcile("Influencer", "inf-1", [
          { platform: "Instagram", handle: "x" },
        ]),
      ).toBe(0);
      expect(stateModel.find).not.toHaveBeenCalled();
    });
  });

  describe("read-time validity (does not depend on reconcile having run)", () => {
    it("reports a decision whose snapshot no longer matches as pending/stale", () => {
      const decision = {
        status: "verified",
        method: "manual",
        decidedHandle: "old",
        decidedById: "admin-1",
      };
      expect(
        effectiveDecision("ownership", decision, { handle: "new" }),
      ).toEqual({
        status: "pending",
        stale: true,
        lastDecision: decision,
      });
      expect(
        effectiveDecision("ownership", decision, { handle: "old" }).status,
      ).toBe("verified");
      expect(
        effectiveDecision(
          "tier",
          { status: "rejected", decidedTier: "Micro" },
          { tier: "Macro" },
        ).status,
      ).toBe("pending");
    });
  });

  describe("legacy profiles", () => {
    it("profiles with no decisions and entries with no id read as pending", async () => {
      const { service } = setup();
      const list = await service.listForProfile("Photographer", "ph-1", [
        instagram(),
        { platform: "YouTube", handle: "legacy", tier: "Nano" },
      ]);
      expect(list).toEqual([
        expect.objectContaining({
          socialAccountId: ID_A,
          ownershipVerification: { status: "pending" },
          tierVerification: { status: "pending" },
        }),
        expect.objectContaining({
          socialAccountId: null,
          handle: "legacy",
          ownershipVerification: { status: "pending" },
          tierVerification: { status: "pending" },
        }),
      ]);
      expect(await service.listForProfile("Brand", "b-1", undefined)).toEqual(
        [],
      );
    });
  });
});

describe("social_account_reviews is append-only", () => {
  const conn = mongoose.createConnection();
  const Review = conn.model(
    "SocialAccountReviewProbe",
    SocialAccountReviewSchema,
  );
  afterAll(() => conn.close());

  it.each([
    ["updateOne", () => Review.updateOne({}, { $set: { note: "x" } }).exec()],
    ["updateMany", () => Review.updateMany({}, { $set: { note: "x" } }).exec()],
    [
      "findOneAndUpdate",
      () => Review.findOneAndUpdate({}, { note: "x" }).exec(),
    ],
    ["replaceOne", () => Review.replaceOne({}, {}).exec()],
    ["deleteOne", () => Review.deleteOne({}).exec()],
    ["deleteMany", () => Review.deleteMany({}).exec()],
    ["findOneAndDelete", () => Review.findOneAndDelete({}).exec()],
  ])("refuses %s", async (_op, run) => {
    await expect(run()).rejects.toThrow("append-only");
  });

  it("refuses re-saving an existing review", async () => {
    const doc: any = new Review({
      socialAccountId: "64b0000000000000000000a1",
      profileId: "inf-1",
      profileType: "Influencer",
      reviewType: "ownership",
      previousStatus: "pending",
      newStatus: "verified",
      method: "manual",
      decidedAt: new Date(),
    });
    doc.isNew = false;
    await expect(doc.save()).rejects.toThrow("append-only");
  });
});

describe("SocialAccountVerificationService.profileIdsWithChangedReviews", () => {
  function svc(rows: any[]) {
    const find = jest.fn(() => ({
      select: jest.fn(() => ({ lean: jest.fn().mockResolvedValue(rows) })),
    }));
    const service = new SocialAccountVerificationService(
      { find } as any,
      {} as any,
      {} as any,
    );
    return { service, find };
  }

  it("finds profiles with a review reset by a change (pending + invalidatedAt)", async () => {
    const { service, find } = svc([
      { profileId: "p1" },
      { profileId: "p1" },
      { profileId: "p2" },
    ]);
    expect([...(await service.profileIdsWithChangedReviews("Brand"))]).toEqual([
      "p1",
      "p2",
    ]);
    expect(find).toHaveBeenCalledWith({
      profileType: "Brand",
      $or: [
        {
          "ownership.status": "pending",
          "ownership.invalidatedAt": { $ne: null },
        },
        { "tier.status": "pending", "tier.invalidatedAt": { $ne: null } },
      ],
    });
  });

  it("can be limited to a page of profiles, and skips the query for an empty page", async () => {
    const { service, find } = svc([]);
    await service.profileIdsWithChangedReviews("Influencer", ["a", "b"]);
    expect((find.mock.calls[0] as any[])[0].profileId).toEqual({
      $in: ["a", "b"],
    });
    const empty = svc([]);
    expect(
      (await empty.service.profileIdsWithChangedReviews("Influencer", [])).size,
    ).toBe(0);
    expect(empty.find).not.toHaveBeenCalled();
  });
});
