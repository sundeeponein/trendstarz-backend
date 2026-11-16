import { normalizeUpiId, payoutFromInput, upiIdError } from "./upi.util";

describe("UPI ID check", () => {
  it("accepts real-looking UPI IDs, in any case", () => {
    for (const ok of ["9876543210@ybl", "Ravi.Kumar@okhdfcbank", "shop-1_a@paytm", "  name@upi  "]) {
      expect(upiIdError(ok)).toBeNull();
    }
    expect(normalizeUpiId("  Ravi.Kumar@OKHDFCBANK ")).toBe("ravi.kumar@okhdfcbank");
  });

  it("refuses typos, phone numbers and emails", () => {
    for (const bad of ["9876543210", "name@", "@ybl", "name@@ybl", "name@gmail.com", "na me@ybl", "n@ybl"]) {
      expect(upiIdError(bad)).toMatch(/doesn't look right/);
    }
  });

  it("an empty value just means 'not given'", () => {
    expect(upiIdError("")).toBeNull();
    expect(upiIdError(undefined)).toBeNull();
  });

  it("signup payout details: tidied, and a mistyped UPI ID is refused", () => {
    const fail = (m: string): never => {
      throw new Error(m);
    };
    expect(payoutFromInput({ upiId: " Ravi@YBL ", mobile: " 98765 ", accountHolderName: " Ravi " }, fail)).toEqual({
      upiId: "ravi@ybl",
      mobile: "98765",
      accountHolderName: "Ravi",
    });
    expect(payoutFromInput(undefined, fail)).toEqual({ upiId: "", mobile: "", accountHolderName: "" });
    expect(() => payoutFromInput({ upiId: "ravi" }, fail)).toThrow(/doesn't look right/);
  });
});

describe("upiChangedRecently (2026-11-16)", () => {
  const { upiChangedRecently } = require("./upi.util");
  const now = new Date("2026-11-16T10:00:00Z");
  it("holds automatic payouts for 7 days after a change", () => {
    expect(upiChangedRecently(new Date("2026-11-10T10:00:00Z"), now)).toBe(true);
    expect(upiChangedRecently(new Date("2026-11-09T09:59:00Z"), now)).toBe(false);
    expect(upiChangedRecently(null, now)).toBe(false);
    expect(upiChangedRecently("not a date", now)).toBe(false);
  });
});
