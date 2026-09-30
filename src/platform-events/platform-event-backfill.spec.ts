import { Types } from "mongoose";
import {
  INVITE_WITHDRAWN_REASONS,
  PLATFORM_EVENT_TYPES,
} from "./platform-event-types";

// The backfill runs as a plain-node cron script; its derivation logic lives in a
// CommonJS module so it can be tested here without a database.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const backfill = require("../../cron/lib/platformEventBackfill");

const oid = (hex: string) => new Types.ObjectId(hex);
const id = (n: number) => n.toString(16).padStart(24, "0");

const BRAND = id(1);
const CAMPAIGN = id(2);
const OPEN_CAMPAIGN = id(3);
const CREATOR = id(4);
const INVITE = id(5);
const DECLINED_INVITE = id(6);
const OPEN_INVITE = id(7);
const SUBMISSION = id(8);
const TX = id(9);

const at = (iso: string) => new Date(iso);

function fixture() {
  return {
    campaigns: [
      {
        _id: oid(CAMPAIGN),
        brandId: BRAND, // stored as a string — typical of the Mixed field
        ownerType: "brand",
        campaignMode: "invite_only",
        status: "completed",
        completedBy: "auto",
        createdAt: at("2026-01-01T00:00:00Z"),
        completedAt: at("2026-02-01T00:00:00Z"),
      },
      {
        _id: oid(OPEN_CAMPAIGN),
        brandId: "acme_brand", // legacy username reference
        campaignMode: "tier_filtered_open",
        status: "active",
        createdAt: at("2026-01-05T00:00:00Z"),
      },
    ],
    invites: [
      {
        _id: oid(INVITE),
        campaignId: CAMPAIGN,
        brandId: BRAND,
        influencerId: oid(CREATOR),
        status: "completed",
        selectedPlatform: "Instagram",
        createdAt: at("2026-01-02T00:00:00Z"),
        acceptedAt: at("2026-01-03T00:00:00Z"),
      },
      {
        _id: oid(DECLINED_INVITE),
        campaignId: CAMPAIGN,
        brandId: BRAND,
        influencerId: oid(CREATOR),
        status: "declined",
        createdAt: at("2026-01-02T00:00:00Z"),
      },
      {
        _id: oid(OPEN_INVITE),
        campaignId: OPEN_CAMPAIGN,
        brandId: "acme_brand",
        influencerId: oid(CREATOR),
        status: "pending",
        createdAt: at("2026-01-06T00:00:00Z"),
      },
    ],
    submissions: [
      {
        _id: oid(SUBMISSION),
        campaignId: CAMPAIGN,
        influencerId: oid(CREATOR),
        inviteId: oid(INVITE),
        status: "approved",
        postPlatform: "instagram",
        resubmissionCount: 0,
        submittedAt: at("2026-01-10T00:00:00Z"),
        reviewedAt: at("2026-01-12T00:00:00Z"),
      },
    ],
    transactions: [
      {
        _id: oid(TX),
        campaignId: CAMPAIGN,
        inviteId: INVITE,
        payerId: BRAND,
        payerRole: "brand",
        collectionStatus: "verified",
        collectedAt: at("2026-01-04T00:00:00Z"),
        payoutStatus: "paid",
        payoutGatewayProvider: "manual_upi",
        paidOutAt: at("2026-01-20T00:00:00Z"),
      },
    ],
  };
}

const derive = () => backfill.deriveEvents(fixture(), oid);

/** In-memory stand-in for bulkWrite upserts with a unique dedupeKey. */
function applyUpserts(store: Map<string, any>, ops: any[]) {
  let inserted = 0;
  for (const { updateOne } of ops) {
    const key = updateOne.filter.dedupeKey;
    if (!store.has(key)) {
      store.set(key, updateOne.update.$setOnInsert);
      inserted++;
    }
  }
  return inserted;
}

describe("platform event backfill", () => {
  it("only derives event types the platform knows", () => {
    for (const type of backfill.BACKFILLABLE_EVENT_TYPES) {
      expect(PLATFORM_EVENT_TYPES).toContain(type);
    }
    for (const e of derive().events) {
      expect(backfill.BACKFILLABLE_EVENT_TYPES).toContain(e.eventType);
    }
  });

  it("derives events with their historical timestamps and derivation metadata", () => {
    const events = derive().events;
    const find = (type: string, stage?: string) =>
      events.find(
        (e: any) =>
          e.eventType === type && (!stage || e.metadata.stage === stage),
      );

    expect(find("campaign_created").timestamp).toEqual(
      at("2026-01-01T00:00:00Z"),
    );
    expect(find("creator_invited").timestamp).toEqual(
      at("2026-01-02T00:00:00Z"),
    );
    expect(find("invite_accepted").timestamp).toEqual(
      at("2026-01-03T00:00:00Z"),
    );
    expect(find("content_submitted").timestamp).toEqual(
      at("2026-01-10T00:00:00Z"),
    );
    expect(find("content_approved").timestamp).toEqual(
      at("2026-01-12T00:00:00Z"),
    );
    expect(find("campaign_completed").timestamp).toEqual(
      at("2026-02-01T00:00:00Z"),
    );
    expect(find("payment_completed", "collection").timestamp).toEqual(
      at("2026-01-04T00:00:00Z"),
    );
    expect(find("payment_completed", "payout").timestamp).toEqual(
      at("2026-01-20T00:00:00Z"),
    );

    for (const e of events) {
      expect(e.metadata).toMatchObject({
        source: "backfill",
        confidence: "derived",
      });
      expect(typeof e.metadata.derivedFrom).toBe("string");
      expect(e.dedupeKey).toBeTruthy();
    }
  });

  it("stores string-held ids as ObjectIds and keeps usernames as legacy refs", () => {
    const events = derive().events;
    const invited = events.find((e: any) => e.eventType === "creator_invited");
    expect(invited.brandId).toBeInstanceOf(Types.ObjectId);
    expect(invited.campaignId).toBeInstanceOf(Types.ObjectId);
    expect(String(invited.campaignId)).toBe(CAMPAIGN);

    const openCreated = events.find(
      (e: any) =>
        e.eventType === "campaign_created" &&
        String(e.campaignId) === OPEN_CAMPAIGN,
    );
    expect(openCreated.brandId).toBeNull();
    expect(openCreated.metadata.legacyIds).toEqual({
      brandId: "acme_brand",
      userId: "acme_brand",
    });
  });

  it("does not invent events that cannot be reconstructed", () => {
    const { events, skipped } = derive();
    const types = events.map((e: any) => e.eventType);
    expect(types).not.toContain("invite_viewed");
    expect(types).not.toContain("creator_selected");
    expect(types).not.toContain("invite_declined");
    expect(types).not.toContain("creator_applied");
    // The open-campaign invite could be an owner invite or a creator application.
    expect(events.some((e: any) => String(e.inviteId) === OPEN_INVITE)).toBe(
      false,
    );
    expect(skipped["invite_declined: no decline timestamp stored"]).toBe(1);
    expect(
      skipped[
        "creator_invited/creator_applied: open campaign (invite vs application not recorded)"
      ],
    ).toBe(1);
  });

  it("uses the same dedupeKeys as live recording", () => {
    const keys = derive().events.map((e: any) => e.dedupeKey);
    expect(keys).toEqual(
      expect.arrayContaining([
        `campaign_created:${CAMPAIGN}`,
        `creator_invited:${INVITE}`,
        `invite_accepted:${INVITE}`,
        `content_submitted:${INVITE}:0`,
        `content_approved:${INVITE}`,
        `campaign_completed:${CAMPAIGN}`,
        `payment_completed:collection:${TX}`,
        `payment_completed:payout:${TX}`,
      ]),
    );
  });

  it("is idempotent: a second run inserts nothing", () => {
    const store = new Map<string, any>();
    const now = new Date();
    const first = applyUpserts(
      store,
      backfill.toUpsertOps(derive().events, now),
    );
    const second = applyUpserts(
      store,
      backfill.toUpsertOps(derive().events, now),
    );
    expect(first).toBe(derive().events.length);
    expect(second).toBe(0);
    expect(store.size).toBe(first);
  });

  it("never overwrites an event the live code already recorded", () => {
    const live = { eventType: "invite_accepted", metadata: { source: "live" } };
    const store = new Map<string, any>([[`invite_accepted:${INVITE}`, live]]);
    applyUpserts(store, backfill.toUpsertOps(derive().events, new Date()));
    expect(store.get(`invite_accepted:${INVITE}`)).toBe(live);
  });

  it("only uses insert-only upserts", () => {
    for (const op of backfill.toUpsertOps(derive().events, new Date())) {
      expect(op.updateOne.upsert).toBe(true);
      expect(Object.keys(op.updateOne.update)).toEqual(["$setOnInsert"]);
    }
  });

  describe("invite_withdrawn", () => {
    const withdrawn = (n: number, fields: any) => ({
      _id: oid(id(100 + n)),
      campaignId: CAMPAIGN,
      brandId: BRAND,
      influencerId: oid(CREATOR),
      status: "withdrawn",
      createdAt: at("2026-01-02T00:00:00Z"),
      ...fields,
    });
    const deriveWithdrawn = (invites: any[]) => {
      const data = fixture();
      data.invites = invites;
      data.submissions = [];
      data.transactions = [];
      return backfill.deriveEvents(data, oid);
    };
    const withdrawnEvents = (res: any) =>
      res.events.filter((e: any) => e.eventType === "invite_withdrawn");

    it("classifies only the exact reason strings the system writes", () => {
      expect(
        backfill.classifyWithdrawnReason(
          "Auto-closed after 1 influencer acceptance.",
        ),
      ).toBe("auto_close");
      expect(
        backfill.classifyWithdrawnReason(
          "Auto-closed after 3 photographer acceptances.",
        ),
      ).toBe("auto_close");
      expect(
        backfill.classifyWithdrawnReason(
          "Campaign ended before this invite was accepted.",
        ),
      ).toBe("expired_never_accepted");
      for (const t of [
        "Campaign's grace period ended with no submission.",
        "Campaign ended by host before submission.",
        "Posting deadline and grace period expired with no submission.",
      ]) {
        expect(backfill.classifyWithdrawnReason(t)).toBe("expired_unsubmitted");
      }
      expect(
        backfill.classifyWithdrawnReason("Auto-closed because I said so"),
      ).toBeNull();
      expect(backfill.classifyWithdrawnReason("Budget cut")).toBeNull();
      expect(backfill.classifyWithdrawnReason(undefined)).toBeNull();
    });

    it("only ever classifies into known reasons", () => {
      for (const t of [
        "Auto-closed after 2 influencer acceptances.",
        "Campaign ended by host before submission.",
      ]) {
        expect(INVITE_WITHDRAWN_REASONS).toContain(
          backfill.classifyWithdrawnReason(t),
        );
      }
    });

    it("derives the event from withdrawnAt, with reason null when unclassifiable", () => {
      const res = deriveWithdrawn([
        withdrawn(1, {
          withdrawnAt: at("2026-01-05T00:00:00Z"),
          withdrawnReason: "Campaign ended before this invite was accepted.",
        }),
        withdrawn(2, {
          withdrawnAt: at("2026-01-06T00:00:00Z"),
          withdrawnReason: "Found someone cheaper, call me",
        }),
      ]);
      const events = withdrawnEvents(res);
      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({
        timestamp: at("2026-01-05T00:00:00Z"),
        userRole: "system",
        dedupeKey: `invite_withdrawn:${id(101)}`,
        metadata: {
          reason: "expired_never_accepted",
          previousStatus: null,
          derivedFrom: "invite.withdrawnAt",
        },
      });
      expect(events[1].metadata.reason).toBeNull();
      expect(events[1].userRole).toBeNull();
      // Owner-typed text never reaches the event.
      expect(JSON.stringify(events)).not.toContain("cheaper");
    });

    it("skips withdrawals without a timestamp (admin cancel-participation never set one)", () => {
      const res = deriveWithdrawn([withdrawn(3, {})]);
      expect(withdrawnEvents(res)).toHaveLength(0);
      expect(
        res.skipped[
          "invite_withdrawn: withdrawn without withdrawnAt (e.g. admin cancel-participation)"
        ],
      ).toBe(1);
    });

    it("never derives the events that have no reliable timestamp", () => {
      const types = derive().events.map((e: any) => e.eventType);
      for (const t of [
        "work_started",
        "content_disputed",
        "counter_offer_sent",
      ]) {
        expect(types).not.toContain(t);
        expect(backfill.BACKFILLABLE_EVENT_TYPES).not.toContain(t);
      }
    });
  });
});
