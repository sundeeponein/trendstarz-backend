import { istDayKey } from "./profile-traffic-daily.util";

/**
 * The day a daily usage limit (searches, profile views) counts against:
 * the India calendar day, so limits reset at midnight IST — not 05:30 IST as
 * with a UTC day. One function for the counters, the guard and the
 * "search again on …" message, so they can never disagree.
 */
export function usageDayKey(date: Date = new Date()): string {
  return istDayKey(date);
}

/** The next India calendar day (when today's limit resets). */
export function nextUsageDayKey(date: Date = new Date()): string {
  return istDayKey(new Date(date.getTime() + 24 * 60 * 60 * 1000));
}
