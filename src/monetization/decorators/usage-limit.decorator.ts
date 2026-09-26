import { SetMetadata } from "@nestjs/common";

export type UsageMetric = "search" | "profile_view";

export const USAGE_LIMIT_METADATA_KEY = "usageLimit";

export interface UsageLimitMetadata {
  metric: UsageMetric;
  limitKey: string;
}

export const UsageLimit = (
  metric: UsageMetric,
  limitKey: string,
) => SetMetadata(USAGE_LIMIT_METADATA_KEY, { metric, limitKey } as UsageLimitMetadata);
