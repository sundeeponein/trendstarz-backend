import { Types } from "mongoose";
import {
  changedProfileSections,
  recordCreatorUpdate,
  sectionsProjection,
} from "./creator-update.util";

describe("changedProfileSections", () => {
  it("reports nothing when a save re-sends the same values", () => {
    const before = {
      name: "Asha",
      bio: "",
      location: { state: "Telangana", district: "Hyderabad" },
      categories: ["Fashion", "Beauty"],
    };
    expect(
      changedProfileSections(before, {
        name: "Asha",
        bio: null, // "" vs null vs missing are the same empty value
        location: { district: "Hyderabad", state: "Telangana" }, // key order doesn't matter
        categories: ["Fashion", "Beauty"],
      }),
    ).toEqual([]);
  });

  it("reports each changed top-level section once, sorted", () => {
    expect(
      changedProfileSections(
        { name: "Asha", location: { state: "TS" }, categories: ["Fashion"] },
        { name: "Asha K", location: { state: "AP" }, categories: ["Fashion"] },
      ),
    ).toEqual(["location", "name"]);
  });

  it("reports the root of dotted keys", () => {
    expect(
      changedProfileSections(
        { payout: { upiId: "a@upi", mobile: "9" } },
        { "payout.upiId": "b@upi", "payout.mobile": "9" },
      ),
    ).toEqual(["payout"]);
  });

  it("array order is a change (e.g. a new primary photo)", () => {
    expect(
      changedProfileSections(
        { profileImages: [{ url: "a" }, { url: "b" }] },
        { profileImages: [{ url: "b" }, { url: "a" }] },
      ),
    ).toEqual(["profileImages"]);
  });

  it("ignores ids, timestamps and server-set verification state, but not the phone itself", () => {
    const id = new Types.ObjectId();
    expect(
      changedProfileSections(
        {
          socialMedia: [
            {
              _id: id,
              handle: "x",
              selfReportedStats: { avgLikes: 1, lastUpdatedAt: new Date(1) },
            },
          ],
          isMobileVerified: true,
          phoneNumber: "9000000000",
        },
        {
          socialMedia: [
            {
              _id: new Types.ObjectId(),
              handle: "x",
              selfReportedStats: { avgLikes: 1, lastUpdatedAt: new Date() },
            },
          ],
          isMobileVerified: false,
          mobileVerifiedAt: null,
          previousVerifiedMobile: "9000000000",
          phoneNumber: "9111111111",
        },
      ),
    ).toEqual(["phoneNumber"]);
  });

  it("compares Dates and ObjectIds by value", () => {
    const id = new Types.ObjectId();
    expect(
      changedProfileSections(
        { dateOfBirth: new Date("2000-01-01T00:00:00Z"), ref: id },
        {
          dateOfBirth: "2000-01-01T00:00:00.000Z",
          ref: new Types.ObjectId(id.toHexString()),
        },
      ),
    ).toEqual([]);
  });

  it("a social handle change is a socialMedia change; same merged entry is not", () => {
    const entry = {
      socialAccountId: "64b0000000000000000000a1",
      platform: "Instagram",
      handle: "old",
      tier: "Micro",
    };
    expect(
      changedProfileSections(
        { socialMedia: [entry] },
        { socialMedia: [{ ...entry }] },
      ),
    ).toEqual([]);
    expect(
      changedProfileSections(
        { socialMedia: [entry] },
        { socialMedia: [{ ...entry, handle: "new" }] },
      ),
    ).toEqual(["socialMedia"]);
  });

  it("handles a missing before document", () => {
    expect(changedProfileSections(null, { name: "A" })).toEqual(["name"]);
    expect(changedProfileSections({}, {})).toEqual([]);
  });
});

describe("sectionsProjection", () => {
  it("projects exactly the touched keys", () => {
    expect(
      sectionsProjection({ name: 1, "payout.upiId": 2, socialMedia: [] }),
    ).toBe("name payout.upiId socialMedia");
  });
});

describe("recordCreatorUpdate", () => {
  it("sets the time and adds the sections without duplicates", async () => {
    const model = { updateOne: jest.fn().mockResolvedValue({}) };
    const now = new Date("2026-10-01T10:00:00Z");
    await recordCreatorUpdate(
      model as any,
      "inf-1",
      ["location", "socialMedia"],
      now,
    );
    expect(model.updateOne).toHaveBeenCalledWith(
      { _id: "inf-1" },
      {
        $set: { creatorUpdatedAt: now },
        $addToSet: {
          creatorUpdatedFields: { $each: ["location", "socialMedia"] },
        },
      },
    );
  });

  it("does nothing when nothing changed", async () => {
    const model = { updateOne: jest.fn() };
    await recordCreatorUpdate(model as any, "inf-1", []);
    expect(model.updateOne).not.toHaveBeenCalled();
  });

  it("never throws — the creator's save already succeeded", async () => {
    const model = {
      updateOne: jest.fn().mockRejectedValue(new Error("db down")),
    };
    const err = jest
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    await expect(
      recordCreatorUpdate(model as any, "inf-1", ["name"]),
    ).resolves.toBeUndefined();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});
