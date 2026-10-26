import { settingsDiff } from "./admin-action-log.util";

describe("settings change record", () => {
  it("keeps only fields that changed, with old and new values", () => {
    const before = { _id: "x", platformCommissionPercent: 12, gstPercent: 0, gstin: "", offers: [{ key: "bonusMonthsMonthly", value: 1 }], updatedAt: new Date(1) };
    const after = { _id: "x", platformCommissionPercent: 10, gstPercent: 0, gstin: "36ABCDE1234F1Z5", offers: [{ key: "bonusMonthsMonthly", value: 2 }], updatedAt: new Date(2) };
    expect(settingsDiff(before, after)).toEqual({
      platformCommissionPercent: [12, 10],
      gstin: ["", "36ABCDE1234F1Z5"],
      offers: ['[{"key":"bonusMonthsMonthly","value":1}]', '[{"key":"bonusMonthsMonthly","value":2}]'],
    });
  });

  it("never records secret-looking fields or job bookkeeping", () => {
    expect(settingsDiff({ apiSecret: "a", profileMediaCleanupLastRunAt: 1 }, { apiSecret: "b", profileMediaCleanupLastRunAt: 2 })).toEqual({});
  });

  it("a plan created or deleted shows every field once", () => {
    expect(settingsDiff({}, { code: "BRAND_PRO", price: { monthly: 999 } })).toEqual({
      code: [null, "BRAND_PRO"],
      price: [null, '{"monthly":999}'],
    });
  });
});
