import * as jwt from "jsonwebtoken";
import { getJwtSecret } from "../auth/jwt-secret";
import { resolveUploadFolder, uploadCallerFrom } from "./upload-folder.util";

const ME = "6a65de337f69122aa773bd67";
const OTHER = "6a31d9baf9fc45d945b85048";
const sign = (p: any) => `Bearer ${jwt.sign(p, getJwtSecret())}`;

describe("upload folder policy", () => {
  const me = { userId: ME, role: "influencer" };

  it("anyone may use the registration staging folders", () => {
    expect(resolveUploadFolder("influencers/_pending/profile", null, "fb")).toBe("influencers/_pending/profile");
    expect(resolveUploadFolder("brands/_pending/logo", null, "fb")).toBe("brands/_pending/logo");
  });

  it("without login, any other folder falls back (can't plant files in someone's folder)", () => {
    expect(resolveUploadFolder(`influencers/${OTHER}/profile`, null, "fb")).toBe("fb");
    expect(resolveUploadFolder("campaigns/" + OTHER + "/images", null, "fb")).toBe("fb");
    expect(resolveUploadFolder("../etc", null, "fb")).toBe("fb");
  });

  it("logged in: own folders only (role and id must match), plus campaign images", () => {
    expect(resolveUploadFolder(`influencers/${ME}/profile`, me, "fb")).toBe(`influencers/${ME}/profile`);
    expect(resolveUploadFolder(`influencers/${OTHER}/profile`, me, "fb")).toBe("fb");
    expect(resolveUploadFolder(`brands/${ME}/logo`, me, "fb")).toBe("fb"); // not a brand
    expect(resolveUploadFolder(`campaigns/${OTHER}/images`, me, "fb")).toBe(`campaigns/${OTHER}/images`);
    expect(resolveUploadFolder(`campaigns/${OTHER}/proofs/${ME}`, me, "fb")).toBe("fb");
  });

  it("admins may use any well-formed folder", () => {
    expect(resolveUploadFolder(`photographers/${OTHER}/profile`, { userId: ME, role: "admin" }, "fb")).toBe(
      `photographers/${OTHER}/profile`,
    );
  });

  it("reads the caller from a login token; link tokens and junk count as anonymous", () => {
    expect(uploadCallerFrom(sign({ userId: ME, role: "Influencer" }))).toEqual(me);
    expect(uploadCallerFrom(sign({ userId: ME, role: "influencer", purpose: "meta_connect_state" }))).toBeNull();
    expect(uploadCallerFrom("Bearer nope")).toBeNull();
    expect(uploadCallerFrom(undefined)).toBeNull();
  });
});
