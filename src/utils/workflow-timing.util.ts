/**
 * Campaign workflow timing settings (app settings, edited on admin → Management):
 * one place for their default values and for reading a saved value safely.
 */
export const WORKFLOW_TIMING_DEFAULTS = {
  /** Host can mark a submitted post completed after this many hours. */
  submissionApprovalWaitHours: 24,
  /** Auto-complete if the host stays silent this long after that. */
  submissionAutoCompleteGraceHours: 48,
  /** Admin/auto payout release wait. */
  payoutReleaseWaitHours: 24,
  /** A disputed creator must respond within this window. */
  disputeResponseWaitHours: 12,
  /** Campaign auto-closes this long after its end date (also the paid-late submit window). */
  campaignAutoCloseGraceHours: 24,
} as const;

export type WorkflowTimingKey = keyof typeof WORKFLOW_TIMING_DEFAULTS;

export const WORKFLOW_TIMING_KEYS = Object.keys(
  WORKFLOW_TIMING_DEFAULTS,
) as WorkflowTimingKey[];

/** A saved hours setting: the saved number when valid (>= 0), else the default. */
export function settingHours(settings: any, key: WorkflowTimingKey): number {
  const fallback = WORKFLOW_TIMING_DEFAULTS[key];
  const hours = Number(settings?.[key] ?? fallback);
  return Number.isFinite(hours) && hours >= 0 ? hours : fallback;
}
