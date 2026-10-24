import { canonicalPhone } from "./phone.util";

describe("canonicalPhone", () => {
  it("reduces every way of typing an Indian mobile to its 10 digits", () => {
    for (const typed of ["9876543210", "98765 43210", "+91 98765 43210", "+91-9876543210", "919876543210", "09876543210"]) {
      expect(canonicalPhone(typed)).toBe("9876543210");
    }
  });
  it("keeps other numbers as digits only", () => {
    expect(canonicalPhone("+1 (415) 555-0100")).toBe("14155550100");
    expect(canonicalPhone("")).toBe("");
  });
});
