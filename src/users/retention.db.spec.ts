import { Schema, Types } from "mongoose";
import { UsersService, ADMIN_SOFT_DELETE_RETENTION_DAYS } from "./users.service";
import { NotificationSchema } from "../database/schemas/notification.schema";
import { DB_TEST_TIMEOUT_MS, startTestDb, TestDb } from "../testing/mongo-replset.fixture-spec";

jest.setTimeout(DB_TEST_TIMEOUT_MS);

describe("data retention (real MongoDB)", () => {
  let db: TestDb;
  let service: any;
  const day = 86400000;
  const now = new Date("2026-10-26T01:00:00+05:30");

  beforeAll(async () => {
    db = await startTestDb();
    const loose = (name: string, col: string) => db.conn.model(name, new Schema({}, { strict: false, timestamps: false }), col);
    service = Object.assign(Object.create(UsersService.prototype), {
      influencerModel: loose("Influencer", "influencers"),
      brandModel: loose("Brand", "brands"),
      photographerModel: loose("Photographer", "photographers"),
      profileFlagModel: loose("ProfileFlag", "profile_flags"),
      anonymizeUser: jest.fn(async () => ({})),
      selfDeletionBlocker: jest.fn(async () => null),
    });
  });
  afterAll(() => db.stop());

  it(`anonymizes accounts an admin deleted over ${ADMIN_SOFT_DELETE_RETENTION_DAYS} days ago — not recent, restored, or busy ones`, async () => {
    const old = new Types.ObjectId();
    const recent = new Types.ObjectId();
    const restored = new Types.ObjectId();
    const busy = new Types.ObjectId();
    const done = new Types.ObjectId();
    const longAgo = new Date(now.getTime() - 100 * day);
    await db.conn.collection("influencers").insertMany([
      { _id: old, isDeleted: true, status: "deleted", deletedAt: longAgo },
      { _id: recent, isDeleted: true, status: "deleted", deletedAt: new Date(now.getTime() - 30 * day) },
      { _id: restored, isDeleted: false, status: "accepted", deletedAt: longAgo },
      { _id: done, isDeleted: true, status: "deleted", deletedAt: longAgo, anonymized: true },
    ]);
    await db.conn.collection("brands").insertOne({ _id: busy, isDeleted: true, status: "deleted", deletedAt: longAgo });
    service.selfDeletionBlocker.mockImplementation(async (id: string) => (id === String(busy) ? "A payout is still pending." : null));

    expect(await service.anonymizeStaleSoftDeleted(now)).toEqual({ anonymized: 1, waiting: 1 });
    expect(service.anonymizeUser.mock.calls.map((c: any[]) => c[0])).toEqual([String(old)]);
  });

  it("removes resolved/ignored flags older than a year, keeps open and newer ones", async () => {
    const yearAgo = new Date(now.getTime() - 400 * day);
    await db.conn.collection("profile_flags").insertMany([
      { status: "Resolved", updatedAt: yearAgo },
      { status: "Ignored", updatedAt: yearAgo },
      { status: "Open", updatedAt: yearAgo },
      { status: "Resolved", updatedAt: new Date(now.getTime() - 100 * day) },
    ]);
    expect(await service.deleteOldResolvedFlags(now)).toEqual({ deleted: 2 });
    expect(await db.conn.collection("profile_flags").countDocuments()).toBe(2);
  });

  it("notifications expire after 180 days (TTL index)", async () => {
    const Notification = db.conn.model("Notification", NotificationSchema, "notifications");
    await Notification.init();
    const ttl = (await db.conn.collection("notifications").indexes()).find((i: any) => i.key?.createdAt === 1);
    expect(ttl?.expireAfterSeconds).toBe(180 * 24 * 3600);
  });
});
