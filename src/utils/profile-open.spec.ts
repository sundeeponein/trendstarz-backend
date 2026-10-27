import * as jwt from "jsonwebtoken";
import { canOpenProfile } from "./profile-eligibility.util";
import { profileViewerFromRequest } from "./profile-viewer.util";
import { getJwtSecret } from "../auth/jwt-secret";

/** Settings promise: Private = only you and admins; Logged-in only = hidden from guests. */
describe("who may open a profile page", () => {
  const ownerId = "64b000000000000000000001";
  const live = { _id: ownerId, status: "accepted" };
  const guest = null;
  const member = { userId: "64b000000000000000000002", role: "brand" };
  const owner = { userId: ownerId, role: "influencer" };
  const admin = { userId: "64b000000000000000000003", role: "admin" };

  it.each([
    ["Public", { ...live, profileVisibility: "PUBLIC" }, [true, true, true, true]],
    ["no setting (Public)", { ...live }, [true, true, true, true]],
    ["Logged-in only", { ...live, profileVisibility: "MEMBERS_ONLY" }, [false, true, true, true]],
    ["Private", { ...live, profileVisibility: "PRIVATE" }, [false, false, true, true]],
    ["pending", { ...live, status: "pending" }, [false, false, true, true]],
    ["declined", { ...live, status: "declined" }, [false, false, true, true]],
    ["deleted", { ...live, isDeleted: true }, [false, false, true, true]],
    ["suspended", { ...live, accountStatus: "SUSPENDED" }, [false, false, true, true]],
  ])("%s → guest, member, owner, admin", (_label, profile, expected) => {
    expect([guest, member, owner, admin].map((v) => canOpenProfile(profile, v))).toEqual(expected);
  });

  it("no profile: nobody", () => {
    expect(canOpenProfile(null, admin)).toBe(false);
  });

  describe("the viewer comes only from a real login", () => {
    const req = (token?: string) => ({ headers: token ? { authorization: `Bearer ${token}` } : {} });
    const sign = (claims: object, secret = getJwtSecret()) => jwt.sign(claims, secret, { expiresIn: "1h" });

    it("reads a valid login", () => {
      expect(profileViewerFromRequest(req(sign({ userId: ownerId, role: "Influencer" })))).toEqual({ userId: ownerId, role: "influencer" });
    });
    it.each([
      ["no token", undefined],
      ["purpose token (email verification / Meta connect)", sign({ userId: ownerId, role: "admin", purpose: "meta-connect" })],
      ["wrong signature", sign({ userId: ownerId, role: "admin" }, "not-the-secret")],
      ["garbage", "abc.def"],
      ["no role", sign({ userId: ownerId })],
    ])("%s → guest", (_label, token) => {
      expect(profileViewerFromRequest(req(token as string | undefined))).toBeNull();
    });
  });
});
