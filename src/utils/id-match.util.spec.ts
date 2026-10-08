import { Types } from "mongoose";
import { idIn } from "./id-match.util";

describe("idIn", () => {
  it("matches the ObjectId and its string form", () => {
    const id = new Types.ObjectId("6abb40847cd6bcb51998fb06");
    expect(idIn(id)).toEqual({ $in: [id, "6abb40847cd6bcb51998fb06"] });
  });

  it("a string id is kept as-is (same as the old inline [x, String(x)])", () => {
    expect(idIn("abc")).toEqual({ $in: ["abc", "abc"] });
  });
});
