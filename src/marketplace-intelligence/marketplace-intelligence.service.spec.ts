import { ForbiddenException, UnauthorizedException } from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { RolesGuard } from "../auth/roles.guard";
import { MarketplaceIntelligenceController } from "./marketplace-intelligence.controller";
import { MarketplaceIntelligenceService } from "./marketplace-intelligence.service";

/**
 * A fake connection that ONLY offers read operations. Any write
 * (insert/update/delete/replace/bulkWrite/drop…) would be `undefined` and throw,
 * so a passing test proves the audit is read-only.
 */
function readOnlyConnection(data: {
  counts?: Record<string, number>;
  aggregates?: Record<string, any[]>;
  distincts?: Record<string, any[]>;
}) {
  const calls: string[] = [];
  const collection = (name: string) => {
    const reads = {
      countDocuments: (q: unknown) => {
        calls.push(`${name}.countDocuments`);
        return Promise.resolve(
          data.counts?.[`${name}:${JSON.stringify(q)}`] ??
            data.counts?.[name] ??
            0,
        );
      },
      aggregate: (pipeline: any[]) => {
        calls.push(`${name}.aggregate`);
        const group = pipeline.find((s) => s.$group)?.$group?._id;
        const key = `${name}:${JSON.stringify(group)}`;
        return { toArray: () => Promise.resolve(data.aggregates?.[key] ?? []) };
      },
      distinct: (field: string) => {
        calls.push(`${name}.distinct`);
        return Promise.resolve(data.distincts?.[`${name}:${field}`] ?? []);
      },
    };
    return new Proxy(reads, {
      get(target, prop: string) {
        if (prop in target) return (target as any)[prop];
        throw new Error(
          `write or unexpected operation attempted: ${name}.${prop}`,
        );
      },
    });
  };
  return { connection: { collection } as any, calls };
}

const coverage2B = {
  entities: [
    {
      entity: "influencer",
      records: 3,
      fields: [
        { field: "categories", present: 3 },
        { field: "socialTier", present: 3 },
      ],
    },
    { entity: "campaign", records: 2, fields: [] },
  ],
};

describe("MarketplaceIntelligenceService (Stage 3B-0, read-only)", () => {
  it("builds the report from reads only and reuses Stage 2B attribute coverage", async () => {
    const { connection, calls } = readOnlyConnection({
      counts: {
        influencers: 3,
        campaigns: 2,
        collaboration_audits: 1,
        social_account_observations: 0,
      },
      aggregates: {
        'platform_events:{"t":"$eventType","s":"$metadata.source"}': [
          { _id: { t: "creator_invited", s: "backfill" }, n: 4 },
          { _id: { t: "creator_invited", s: "live" }, n: 1 },
        ],
        'campaigninvites:"$status"': [
          { _id: "declined", n: 2 },
          { _id: "pending", n: 3 },
        ],
        'campaigninvites:"$influencerId"': [
          { _id: "a", n: 3 },
          { _id: "b", n: 1 },
          { _id: "c", n: 2 },
        ],
        'influencers:"$socialMedia.platform"': [{ _id: "Instagram", n: 3 }],
        "influencers:null": [{ total: 4, withId: 4 }],
      },
      distincts: {
        "categories:name": ["Fashion"],
        "socialmedias:contentTypes.name": ["Reel"],
      },
    });
    const platformMetrics = {
      attributeCoverage: jest.fn().mockResolvedValue(coverage2B),
    };
    const service = new MarketplaceIntelligenceService(
      connection,
      platformMetrics as any,
    );

    const report = await service.getReadinessReport(
      new Date("2026-10-02T00:00:00Z"),
    );

    expect(platformMetrics.attributeCoverage).toHaveBeenCalledTimes(1);
    expect(
      calls.every((c) => /\.(countDocuments|aggregate|distinct)$/.test(c)),
    ).toBe(true);
    expect(report.readOnly).toBe(true);
    const invited = report.historicalSignals.events.find(
      (e) => e.eventType === "creator_invited",
    )!;
    expect(invited).toMatchObject({
      total: 5,
      live: 1,
      backfill: 4,
      liveSharePct: 20,
    });
    // 2 declined invites but no invite_declined events → response rate cannot be READY.
    const response = report.derivedMetricReadiness.find(
      (m) => m.metric === "creator.responseRate",
    )!;
    expect(response.readiness).toBe("NOT_READY");
    expect(report.historicalSignals.invitesPerCreator).toEqual({
      creators: 3,
      median: 2,
      max: 3,
      atLeastMinSample: 0,
    });
  });

  it("would fail loudly if it ever attempted a write", () => {
    const { connection } = readOnlyConnection({});
    expect(() =>
      connection.collection("influencers").updateOne({}, {}),
    ).toThrow("write or unexpected operation");
  });
});

describe("MarketplaceIntelligenceController access", () => {
  it("is GET admin/marketplace/intelligence-readiness behind JwtAuthGuard + RolesGuard", () => {
    expect(Reflect.getMetadata("path", MarketplaceIntelligenceController)).toBe(
      "admin/marketplace",
    );
    expect(
      Reflect.getMetadata(
        "path",
        Object.getOwnPropertyDescriptor(
          MarketplaceIntelligenceController.prototype,
          "getReadiness",
        )?.value,
      ),
    ).toBe("intelligence-readiness");
    expect(
      Reflect.getMetadata("__guards__", MarketplaceIntelligenceController),
    ).toEqual([JwtAuthGuard, RolesGuard]);
  });

  const ctx = (user: any, headers: Record<string, string> = {}) =>
    ({
      switchToHttp: () => ({ getRequest: () => ({ user, headers }) }),
      getHandler: () => () => undefined,
      getClass: () => class {},
    }) as any;

  it("admins and subadmins pass; creators and brands are refused", () => {
    const roles = new RolesGuard();
    expect(roles.canActivate(ctx({ role: "admin" }))).toBe(true);
    expect(roles.canActivate(ctx({ role: "subadmin" }))).toBe(true);
    for (const role of ["influencer", "brand", "photographer"]) {
      expect(() => roles.canActivate(ctx({ role }))).toThrow(
        ForbiddenException,
      );
    }
  });

  it("unauthenticated requests are refused before any role check", async () => {
    const jwtGuard = new JwtAuthGuard(
      { getAllAndOverride: () => false } as any,
      { models: {} } as any,
    );
    await expect(jwtGuard.canActivate(ctx(undefined))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it("the controller only delegates to the read-only service", async () => {
    const service = {
      getReadinessReport: jest.fn().mockResolvedValue({ readOnly: true }),
    };
    await expect(
      new MarketplaceIntelligenceController(service as any).getReadiness(),
    ).resolves.toEqual({
      readOnly: true,
    });
  });
});
