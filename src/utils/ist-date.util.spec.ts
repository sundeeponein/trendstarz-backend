import { formatIstDate } from "./ist-date.util";

describe("formatIstDate", () => {
  it("shows the India date, not the server's UTC date", () => {
    // Midnight 30 Oct in India is still 29 Oct in UTC.
    expect(formatIstDate(new Date("2026-10-29T18:30:00Z"))).toBe("30 Oct 2026");
    // 11:59 PM India on 30 Oct.
    expect(formatIstDate("2026-10-30T18:29:00Z")).toBe("30 Oct 2026");
    expect(formatIstDate(null)).toBe("");
    expect(formatIstDate("not a date")).toBe("");
  });
});
