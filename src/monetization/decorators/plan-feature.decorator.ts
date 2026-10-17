import { SetMetadata } from "@nestjs/common";

export const PLAN_FEATURE_METADATA_KEY = "requiredPlanFeature";

export const RequirePlanFeature = (featureKey: string) =>
  SetMetadata(PLAN_FEATURE_METADATA_KEY, featureKey);
