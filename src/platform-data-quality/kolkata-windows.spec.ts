import { kolkataWindows, startOfKolkataDay } from "./kolkata-windows";

describe("Asia/Kolkata windows", () => {
  it("uses the IST calendar day, not the UTC one", () => {
    // 2026-10-15 01:00 IST is still 2026-10-14 in UTC.
    const now = new Date("2026-10-14T19:30:00.000Z");
    expect(startOfKolkataDay(now).toISOString()).toBe(
      "2026-10-14T18:30:00.000Z",
    );
    const w = kolkataWindows(now);
    expect(w.today).toEqual({
      from: new Date("2026-10-14T18:30:00.000Z"),
      to: now,
    });
    expect(w.yesterday).toEqual({
      from: new Date("2026-10-13T18:30:00.000Z"),
      to: new Date("2026-10-14T18:30:00.000Z"),
    });
  });

  it("builds last-7/30-day and month-to-date windows from IST midnight", () => {
    const now = new Date("2026-10-15T06:00:00.000Z"); // 11:30 IST
    const w = kolkataWindows(now);
    expect(w.last7Days.from.toISOString()).toBe("2026-10-08T18:30:00.000Z");
    expect(w.last30Days.from.toISOString()).toBe("2026-09-15T18:30:00.000Z");
    expect(w.monthToDate.from.toISOString()).toBe("2026-09-30T18:30:00.000Z");
  });

  it("starts month-to-date on the IST month even when UTC is still in the previous month", () => {
    const now = new Date("2026-09-30T20:00:00.000Z"); // 1 Oct 01:30 IST
    expect(kolkataWindows(now).monthToDate.from.toISOString()).toBe(
      "2026-09-30T18:30:00.000Z",
    );
  });
});
