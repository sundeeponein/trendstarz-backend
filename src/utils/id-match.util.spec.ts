import { Types } from "mongoose";
import { idIn, idsIn } from "./id-match.util";

describe("idIn", () => {
  it("matches the ObjectId and its string form", () => {
    const id = new Types.ObjectId("6abb40847cd6bcb51998fb06");
    expect(idIn(id)).toEqual({ $in: [id, "6abb40847cd6bcb51998fb06"] });
  });

  it("a string id is kept as-is (same as the old inline [x, String(x)])", () => {
    expect(idIn("abc")).toEqual({ $in: ["abc", "abc"] });
  });
});

describe("idsIn", () => {
  it("adds the ObjectId form of each valid id (aggregate $match does no casting)", () => {
    const hex = "6abb40847cd6bcb51998fb06";
    const { $in } = idsIn([hex, "brand_username", ""]);
    expect($in).toContain(hex);
    expect($in).toContain("brand_username");
    expect($in.some((v) => v instanceof Types.ObjectId && v.toHexString() === hex)).toBe(true);
    expect($in).toHaveLength(3);
  });
});
