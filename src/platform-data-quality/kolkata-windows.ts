/**
 * Human calendar windows in Asia/Kolkata. Event timestamps stay stored in UTC;
 * only the window boundaries are IST calendar days. India has no daylight saving,
 * so a fixed +05:30 offset is exact.
 */
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export type WindowKey =
  | "today"
  | "yesterday"
  | "last7Days"
  | "last30Days"
  | "monthToDate";

export interface TimeWindow {
  /** Inclusive, UTC instant. */
  from: Date;
  /** Exclusive, UTC instant. */
  to: Date;
}

/** UTC instant of 00:00 IST on the IST calendar day containing `at`. */
export function startOfKolkataDay(at: Date): Date {
  const ist = at.getTime() + IST_OFFSET_MS;
  return new Date(ist - (((ist % DAY_MS) + DAY_MS) % DAY_MS) - IST_OFFSET_MS);
}

export function kolkataWindows(now: Date): Record<WindowKey, TimeWindow> {
  const today = startOfKolkataDay(now);
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  const monthStart = new Date(
    Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), 1) - IST_OFFSET_MS,
  );
  return {
    today: { from: today, to: now },
    yesterday: { from: new Date(today.getTime() - DAY_MS), to: today },
    // Today plus the 6 previous IST days.
    last7Days: { from: new Date(today.getTime() - 6 * DAY_MS), to: now },
    last30Days: { from: new Date(today.getTime() - 29 * DAY_MS), to: now },
    monthToDate: { from: monthStart, to: now },
  };
}
