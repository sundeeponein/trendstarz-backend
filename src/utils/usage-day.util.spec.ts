import { nextUsageDayKey, usageDayKey } from "./usage-day.util";

describe("usage day (daily limits reset at midnight India time)", () => {
  it("00:30 IST on 19 Oct is already the 19th (a UTC day would still say the 18th)", () => {
    const at = new Date("2026-10-18T19:00:00Z"); // 00:30 IST, 19 Oct
    expect(usageDayKey(at)).toBe("2026-10-19");
    expect(nextUsageDayKey(at)).toBe("2026-10-20");
  });

  it("23:59 IST on 18 Oct is still the 18th", () => {
    expect(usageDayKey(new Date("2026-10-18T18:29:00Z"))).toBe("2026-10-18");
  });
});
