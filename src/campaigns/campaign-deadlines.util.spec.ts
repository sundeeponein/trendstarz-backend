import {
  campaignEndsAt,
  endOfIstDay,
  submissionWindow,
  graceHoursFromSettings,
} from "./campaign-deadlines.util";

const iso = (d: Date | null | undefined) => d?.toISOString();

describe("campaign deadlines", () => {
  describe("endOfIstDay / campaignEndsAt", () => {
    it("an end date stored as midnight UTC (05:30 IST) ends at 23:59:59.999 IST that day", () => {
      expect(iso(endOfIstDay(new Date("2026-10-06T00:00:00.000Z")))).toBe(
        "2026-10-06T18:29:59.999Z",
      );
    });

    it("an end date stored as IST midnight is the same India day", () => {
      expect(iso(endOfIstDay(new Date("2026-10-05T18:30:00.000Z")))).toBe(
        "2026-10-06T18:29:59.999Z",
      );
    });

    it("uses the later of endDate and timelineEnd", () => {
      expect(
        iso(
          campaignEndsAt({
            endDate: "2026-10-10T00:00:00.000Z",
            timelineEnd: "2026-10-08T00:00:00.000Z",
          }),
        ),
      ).toBe("2026-10-10T18:29:59.999Z");
      expect(campaignEndsAt({})).toBeNull();
    });

    it("campaign 2–6 Oct with 48h grace stays open until the end of 8 Oct (IST)", () => {
      const ends = campaignEndsAt({ endDate: "2026-10-06T00:00:00.000Z" })!;
      const closes = new Date(ends.getTime() + 48 * 60 * 60 * 1000);
      expect(iso(closes)).toBe("2026-10-08T18:29:59.999Z");
    });
  });

  describe("submissionWindow", () => {
    const POST = "2026-10-07T00:00:00.000Z";

    it("no post date → no deadline (unchanged)", () => {
      expect(submissionWindow({ paymentConfirmedAt: POST })).toBeNull();
    });

    it("grace mode: late after post date + 24h, closed after + 48h (unchanged)", () => {
      const w = submissionWindow(
        {
          selectedPostDate: POST,
          paymentConfirmedAt: "2026-09-30T12:00:00.000Z",
        },
        "grace_24h",
      )!;
      expect(iso(w.strictDeadline)).toBe("2026-10-08T00:00:00.000Z");
      expect(iso(w.closesAt)).toBe("2026-10-09T00:00:00.000Z");
    });

    it("strict mode: closes at post date + 24h (unchanged)", () => {
      const w = submissionWindow({ selectedPostDate: POST }, "strict")!;
      expect(iso(w.closesAt)).toBe("2026-10-08T00:00:00.000Z");
    });

    it("paid on the last day with an earlier post date: admin grace from payment, not late", () => {
      const paid = "2026-10-06T15:00:00.000Z";
      for (const mode of ["grace_24h", "strict"]) {
        const w = submissionWindow(
          {
            selectedPostDate: "2026-10-04T00:00:00.000Z",
            paymentConfirmedAt: paid,
          },
          mode,
          48,
        )!;
        expect(iso(w.closesAt)).toBe("2026-10-08T15:00:00.000Z");
        expect(iso(w.strictDeadline)).toBe("2026-10-08T15:00:00.000Z");
      }
    });

    it("campaign 7–10 Oct, user paid 10 Oct 15:00 IST: the admin grace decides (24h/12h/30h/empty)", () => {
      const invite = {
        selectedPostDate: "2026-10-07T00:00:00.000Z",
        paymentConfirmedAt: "2026-10-10T09:30:00.000Z", // 15:00 IST
      };
      const closes = (hours: number) =>
        iso(submissionWindow(invite, "grace_24h", hours)!.closesAt);
      expect(closes(24)).toBe("2026-10-11T09:30:00.000Z"); // 11 Oct 15:00 IST
      expect(closes(12)).toBe("2026-10-10T21:30:00.000Z"); // 11 Oct 03:00 IST
      expect(closes(30)).toBe("2026-10-11T15:30:00.000Z"); // 11 Oct 21:00 IST
      // Empty/0: no extra time after payment — the post-date window alone (already over).
      expect(closes(0)).toBe("2026-10-09T00:00:00.000Z");
    });

    it("grace from settings: missing → 24, empty/0/null → none", () => {
      expect(graceHoursFromSettings({})).toBe(24);
      expect(graceHoursFromSettings(null)).toBe(24);
      expect(graceHoursFromSettings({ campaignAutoCloseGraceHours: 30 })).toBe(
        30,
      );
      expect(graceHoursFromSettings({ campaignAutoCloseGraceHours: 12 })).toBe(
        12,
      );
      expect(graceHoursFromSettings({ campaignAutoCloseGraceHours: 0 })).toBe(
        0,
      );
      expect(
        graceHoursFromSettings({ campaignAutoCloseGraceHours: null }),
      ).toBe(0);
      expect(graceHoursFromSettings({ campaignAutoCloseGraceHours: "" })).toBe(
        0,
      );
    });

    it("an admin extension only ever lengthens the window", () => {
      const later = submissionWindow({
        selectedPostDate: POST,
        submissionDeadlineExtendedTo: "2026-10-12T10:00:00.000Z",
      })!;
      expect(iso(later.closesAt)).toBe("2026-10-12T10:00:00.000Z");
      // Late flag still follows the post date.
      expect(iso(later.strictDeadline)).toBe("2026-10-08T00:00:00.000Z");

      const earlier = submissionWindow({
        selectedPostDate: POST,
        submissionDeadlineExtendedTo: "2026-10-07T10:00:00.000Z",
      })!;
      expect(iso(earlier.closesAt)).toBe("2026-10-09T00:00:00.000Z");
    });
  });
});
