import { maskUpiId, upiChangeFields } from "./upi.util";
import { payoutUpiChangedTemplate } from "../email/templates/auth.templates";

describe("payout UPI change record", () => {
  const now = new Date("2026-10-24T10:00:00Z");
  it("records when and what it was, only for a real change", () => {
    expect(upiChangeFields("asha@okaxis", "asha.new@ybl", now)).toEqual({
      "payout.upiChangedAt": now,
      "payout.previousUpiId": "asha@okaxis",
    });
    expect(upiChangeFields("Asha@OKAXIS ", "asha@okaxis", now)).toEqual({}); // same ID
    expect(upiChangeFields("", "asha@okaxis", now)).toEqual({}); // first time added
  });

  it("masks the IDs in the email so it can't be reused", () => {
    expect(maskUpiId("asha.rao@okaxis")).toBe("as***@okaxis");
    const t = payoutUpiChangedTemplate({ name: "<b>Asha</b>", previousMasked: "as***@okaxis", newMasked: "ev***@ybl", settingsUrl: "https://trendstarz.in/settings" });
    expect(t.html).toContain("as***@okaxis");
    expect(t.html).not.toContain("<b>Asha</b>");
    expect(t.text).toContain("ev***@ybl");
  });
});
