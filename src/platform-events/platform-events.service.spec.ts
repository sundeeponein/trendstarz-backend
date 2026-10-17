import { Test, TestingModule } from "@nestjs/testing";
import { getModelToken } from "@nestjs/mongoose";
import { Logger } from "@nestjs/common";
import mongoose, { Types } from "mongoose";
import {
  PlatformEventsService,
  normalizePlatform,
  toObjectIdOrNull,
} from "./platform-events.service";
import { PLATFORM_EVENT_TYPES } from "./platform-event-types";
import { PlatformEventSchema } from "../database/schemas/platform-event.schema";

const BRAND = "64b000000000000000000001";
const CAMPAIGN = "64b000000000000000000002";
const CREATOR = "64b000000000000000000003";
const INVITE = "64b000000000000000000004";

function duplicateKeyError() {
  return Object.assign(new Error("E11000 duplicate key error"), {
    code: 11000,
  });
}

describe("PlatformEventsService", () => {
  let service: PlatformEventsService;
  let model: any;
  let errorSpy: jest.SpyInstance;

  beforeEach(async () => {
    model = {
      create: jest.fn().mockResolvedValue({}),
      insertMany: jest.fn().mockResolvedValue([]),
      find: jest.fn().mockReturnValue({
        select: jest
          .fn()
          .mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }),
      }),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PlatformEventsService,
        { provide: getModelToken("PlatformEvent"), useValue: model },
      ],
    }).compile();
    service = module.get(PlatformEventsService);
    errorSpy = jest
      .spyOn(Logger.prototype, "error")
      .mockImplementation(() => undefined);
  });

  afterEach(() => errorSpy.mockRestore());

  describe("ID consistency", () => {
    it("stores every entity reference as an ObjectId, from strings or populated docs", () => {
      const doc = service.buildDocument({
        eventType: "invite_accepted",
        userId: CREATOR,
        brandId: { _id: new Types.ObjectId(BRAND), brandName: "B" },
        campaignId: new Types.ObjectId(CAMPAIGN),
        influencerId: CREATOR,
        inviteId: INVITE,
      });
      for (const field of [
        "userId",
        "brandId",
        "campaignId",
        "influencerId",
        "inviteId",
      ]) {
        expect(doc[field]).toBeInstanceOf(Types.ObjectId);
      }
      expect(String(doc.brandId)).toBe(BRAND);
      expect(String(doc.campaignId)).toBe(CAMPAIGN);
      expect(doc.metadata.legacyIds).toBeUndefined();
    });

    it("keeps non-ObjectId legacy references (e.g. brand usernames) in metadata instead of dropping them", () => {
      const doc = service.buildDocument({
        eventType: "campaign_created",
        brandId: "acme_brand",
        userId: "admin",
        campaignId: CAMPAIGN,
      });
      expect(doc.brandId).toBeNull();
      expect(doc.userId).toBeNull();
      expect(doc.metadata.legacyIds).toEqual({
        brandId: "acme_brand",
        userId: "admin",
      });
    });

    it("toObjectIdOrNull rejects anything that is not a 24-hex id", () => {
      expect(toObjectIdOrNull(null)).toBeNull();
      expect(toObjectIdOrNull("")).toBeNull();
      expect(toObjectIdOrNull("inv1")).toBeNull();
      expect(String(toObjectIdOrNull(` ${BRAND} `))).toBe(BRAND);
    });
  });

  describe("buildDocument", () => {
    it("uses the given timestamp and defaults it to now", () => {
      const at = new Date("2025-01-02T03:04:05Z");
      expect(
        service.buildDocument({ eventType: "campaign_created", timestamp: at })
          .timestamp,
      ).toBe(at);

      const before = Date.now();
      const doc = service.buildDocument({ eventType: "campaign_created" });
      expect(doc.timestamp.getTime()).toBeGreaterThanOrEqual(before);
      expect(doc.timestamp.getTime()).toBeLessThanOrEqual(Date.now());
    });

    it("leaves platform null when not applicable and normalizes it otherwise", () => {
      expect(
        service.buildDocument({ eventType: "campaign_created" }).platform,
      ).toBeNull();
      expect(
        service.buildDocument({
          eventType: "creator_invited",
          platform: " Instagram ",
        }).platform,
      ).toBe("instagram");
      expect(normalizePlatform("X")).toBe("twitter");
    });

    it("normalizes recipientRole and marks live events", () => {
      const doc = service.buildDocument({
        eventType: "invite_viewed",
        recipientRole: "Photographer",
      });
      expect(doc.recipientRole).toBe("photographer");
      expect(doc.metadata.source).toBe("live");
      expect(
        service.buildDocument({ eventType: "invite_viewed" }).recipientRole,
      ).toBeNull();
    });

    it("rejects unknown event types", () => {
      expect(() =>
        service.buildDocument({ eventType: "campaign_deleted" as any }),
      ).toThrow(/Unknown platform event type/);
    });
  });

  describe("record", () => {
    it("writes the event", async () => {
      await expect(
        service.record({
          eventType: "content_submitted",
          inviteId: INVITE,
          dedupeKey: "k",
        }),
      ).resolves.toBe(true);
      expect(model.create).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: "content_submitted",
          dedupeKey: "k",
        }),
      );
    });

    it("does not write, and logs, an unknown event type", async () => {
      await expect(
        service.record({ eventType: "made_up" as any }),
      ).resolves.toBe(false);
      expect(model.create).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("made_up"));
    });

    it("treats a duplicate dedupeKey as a silent no-op", async () => {
      model.create.mockRejectedValue(duplicateKeyError());
      await expect(
        service.record({
          eventType: "invite_accepted",
          dedupeKey: "invite_accepted:x",
        }),
      ).resolves.toBe(false);
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it("never throws on a storage failure, but logs it with the event's references", async () => {
      model.create.mockRejectedValue(new Error("connection reset"));
      await expect(
        service.record({
          eventType: "payment_completed",
          inviteId: INVITE,
          campaignId: CAMPAIGN,
        }),
      ).resolves.toBe(false);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringMatching(
          /payment_completed.*64b000000000000000000004.*connection reset/,
        ),
        expect.anything(),
      );
    });
  });

  describe("production readiness", () => {
    it("logs an actionable error, without throwing, when the index build fails", async () => {
      model.init = jest
        .fn()
        .mockRejectedValue(new Error("not authorized to createIndex"));
      expect(() => service.onModuleInit()).not.toThrow();
      await new Promise((r) => setImmediate(r));
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringMatching(
          /index build failed.*dedupe is NOT enforced.*not authorized/s,
        ),
        expect.anything(),
      );
    });

    it("does not log anything when the index build succeeds", async () => {
      model.init = jest.fn().mockResolvedValue(undefined);
      service.onModuleInit();
      await new Promise((r) => setImmediate(r));
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it("write-failure logs carry the event's ids but never its metadata", async () => {
      model.create.mockRejectedValue(new Error("connection reset"));
      await service.record({
        eventType: "payment_completed",
        userRole: "admin",
        campaignId: CAMPAIGN,
        inviteId: INVITE,
        influencerId: CREATOR,
        brandId: BRAND,
        dedupeKey: `payment_completed:payout:${INVITE}`,
        metadata: { payoutUtr: "UTR-SECRET-123", payerTotal: 118000 },
      });
      const [line] = errorSpy.mock.calls[0];
      for (const expected of [
        "payment_completed",
        CAMPAIGN,
        INVITE,
        CREATOR,
        BRAND,
        "admin",
        `payment_completed:payout:${INVITE}`,
        "connection reset",
      ]) {
        expect(line).toContain(expected);
      }
      expect(line).not.toContain("UTR-SECRET-123");
      expect(line).not.toContain("118000");
    });

    it("rejected-event logs identify the event", async () => {
      await service.record({
        eventType: "bogus" as any,
        inviteId: INVITE,
        campaignId: "legacy-ref",
      });
      const [line] = errorSpy.mock.calls[0];
      expect(line).toContain("bogus");
      expect(line).toContain(INVITE);
      expect(line).toContain("legacy-ref");
    });

    it("batch-failure logs list the affected dedupeKeys", async () => {
      model.insertMany.mockRejectedValue(new Error("write concern timeout"));
      await service.recordOnce([
        {
          eventType: "invite_viewed",
          inviteId: INVITE,
          dedupeKey: `invite_viewed:${INVITE}`,
        },
      ]);
      const [line] = errorSpy.mock.calls[0];
      expect(line).toContain(`invite_viewed:${INVITE}`);
      expect(line).toContain("write concern timeout");
    });
  });

  describe("recordOnce (invite_viewed dedupe)", () => {
    const view = (inviteId: string) => ({
      eventType: "invite_viewed" as const,
      inviteId,
      dedupeKey: `invite_viewed:${inviteId}`,
    });

    it("writes only keys not already stored", async () => {
      model.find.mockReturnValue({
        select: jest.fn().mockReturnValue({
          lean: jest
            .fn()
            .mockResolvedValue([{ dedupeKey: `invite_viewed:${INVITE}` }]),
        }),
      });
      const other = "64b000000000000000000005";

      await expect(
        service.recordOnce([view(INVITE), view(other)]),
      ).resolves.toBe(1);

      const inserted = model.insertMany.mock.calls[0][0];
      expect(inserted.map((d: any) => d.dedupeKey)).toEqual([
        `invite_viewed:${other}`,
      ]);
    });

    it("skips the write entirely when every view was already recorded (page refresh)", async () => {
      model.find.mockReturnValue({
        select: jest.fn().mockReturnValue({
          lean: jest
            .fn()
            .mockResolvedValue([{ dedupeKey: `invite_viewed:${INVITE}` }]),
        }),
      });
      await expect(service.recordOnce([view(INVITE)])).resolves.toBe(0);
      expect(model.insertMany).not.toHaveBeenCalled();
    });

    it("treats a concurrent duplicate insert as expected, not an error", async () => {
      model.insertMany.mockRejectedValue(
        Object.assign(new Error("bulk"), {
          writeErrors: [{ code: 11000 }],
          insertedDocs: [],
        }),
      );
      await expect(service.recordOnce([view(INVITE)])).resolves.toBe(0);
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it("rejects inputs without a dedupeKey and never throws", async () => {
      await expect(
        service.recordOnce([{ eventType: "invite_viewed" }]),
      ).resolves.toBe(0);
      expect(model.insertMany).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalled();
    });
  });
});

describe("PlatformEventSchema", () => {
  const PlatformEvent =
    mongoose.models.PlatformEventSpec ||
    mongoose.model("PlatformEventSpec", PlatformEventSchema);

  it("accepts every declared event type", () => {
    for (const eventType of PLATFORM_EVENT_TYPES) {
      const err = new PlatformEvent({
        eventType,
        timestamp: new Date(),
      }).validateSync();
      expect(err).toBeUndefined();
    }
  });

  it("rejects unknown event types and missing timestamps", () => {
    const err: any = new PlatformEvent({
      eventType: "campaign_deleted",
    }).validateSync();
    expect(err.errors.eventType).toBeDefined();
    expect(err.errors.timestamp).toBeDefined();
  });

  it("stores entity references as ObjectIds", () => {
    const ev = new PlatformEvent({
      eventType: "invite_accepted",
      timestamp: new Date(),
      brandId: BRAND,
      campaignId: CAMPAIGN,
      influencerId: CREATOR,
    });
    expect(ev.brandId).toBeInstanceOf(Types.ObjectId);
    expect(ev.campaignId).toBeInstanceOf(Types.ObjectId);
    expect(ev.influencerId).toBeInstanceOf(Types.ObjectId);
    expect(
      new PlatformEvent({
        eventType: "invite_accepted",
        timestamp: new Date(),
        brandId: "acme",
      }).validateSync()?.errors.brandId,
    ).toBeDefined();
  });

  it("declares the query indexes and a unique dedupeKey", () => {
    const indexes = PlatformEventSchema.indexes().map(([fields, opts]) => ({
      fields,
      opts,
    }));
    const keys = indexes.map((i) => JSON.stringify(i.fields));
    expect(keys).toEqual(
      expect.arrayContaining([
        JSON.stringify({ campaignId: 1, timestamp: -1 }),
        JSON.stringify({ influencerId: 1, timestamp: -1 }),
        JSON.stringify({ brandId: 1, timestamp: -1 }),
        JSON.stringify({ eventType: 1, timestamp: -1 }),
        JSON.stringify({ timestamp: -1 }),
      ]),
    );
    const dedupe = indexes.find(
      (i) => JSON.stringify(i.fields) === JSON.stringify({ dedupeKey: 1 }),
    );
    expect(dedupe?.opts).toMatchObject({ unique: true });
  });
});
