import { planMobileChange } from "./pending-mobile.util";

describe("mobile change while verified", () => {
  const verified = { phoneNumber: "9876543210", isMobileVerified: true, pendingPhoneNumber: "" };

  it("keeps the verified number and parks the new one as pending", () => {
    const now = new Date("2026-11-10T10:00:00Z");
    expect(planMobileChange(verified, "+91 91234 56789", now)).toEqual({
      set: { pendingPhoneNumber: "9123456789", pendingPhoneRequestedAt: now },
      applyPhone: false,
      pendingCreated: true,
    });
  });

  it("re-saving the same or the pending number changes nothing (an ordinary save never cancels)", () => {
    expect(planMobileChange(verified, "9876543210")).toEqual({ set: {}, applyPhone: false, pendingCreated: false });
    const waiting = { ...verified, pendingPhoneNumber: "9123456789" };
    expect(planMobileChange(waiting, "9123456789").set).toEqual({});
    expect(planMobileChange(waiting, "9876543210").set).toEqual({});
    expect(planMobileChange(waiting, "9000000001").set).toMatchObject({ pendingPhoneNumber: "9000000001" });
  });

  it("an unverified number is simply replaced", () => {
    const r = planMobileChange({ phoneNumber: "9876543210", isMobileVerified: false }, "9123456789");
    expect(r.applyPhone).toBe(true);
    expect(r.set).toMatchObject({ isMobileVerified: false, pendingPhoneNumber: "" });
  });
});
