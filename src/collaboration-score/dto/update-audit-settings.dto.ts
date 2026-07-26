import { Type } from "class-transformer";
import {
  IsBoolean,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from "class-validator";

// Every field optional — PUT /api/audit/settings is always a partial patch,
// merged onto the current document in CollaborationScoreSettingsService.
// Deliberately NOT used as the controller's @Body() type (that would let
// Nest's global whitelist:true ValidationPipe silently strip any field not
// declared here) — see collaboration-score-settings.service.ts, which
// validates a plainToInstance() of this class manually instead.

class ContentQualityWeightsDto {
  @IsOptional() @IsNumber() @Min(0) @Max(100) rulesPercent?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(100) aiPercent?: number;
}

class ProfessionalBrandingWeightsDto {
  @IsOptional() @IsNumber() @Min(0) @Max(100) rulesPercent?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(100) aiPercent?: number;
}

class WeightsDto {
  @IsOptional() @ValidateNested() @Type(() => ContentQualityWeightsDto) contentQuality?: ContentQualityWeightsDto;
  @IsOptional() @ValidateNested() @Type(() => ProfessionalBrandingWeightsDto) professionalBranding?: ProfessionalBrandingWeightsDto;
}

class ThresholdsDto {
  @IsOptional() @IsNumber() @Min(0) @Max(100) trendstarzRecommendedMinScore?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(100) campaignReadyMinScore?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(100) partiallyReadyMinScore?: number;
}

// Top-level criteria weights — must sum to 100 (checked in the service,
// not here; class-validator has no built-in cross-field sum check).
class ScoreWeightsDto {
  @IsOptional() @IsNumber() @Min(0) @Max(100) profileCompletion?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(100) contentQuality?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(100) postingConsistency?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(100) professionalBranding?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(100) campaignReadiness?: number;
}

class PlatformsEnabledDto {
  @IsOptional() @IsBoolean() instagram?: boolean;
  @IsOptional() @IsBoolean() youtube?: boolean;
  @IsOptional() @IsBoolean() facebook?: boolean;
  @IsOptional() @IsBoolean() linkedin?: boolean;
}

class AnalyticsDto {
  @IsOptional() @IsBoolean() trackAuditCost?: boolean;
  @IsOptional() @IsBoolean() trackAverageScore?: boolean;
  @IsOptional() @IsBoolean() trackPlatformUsage?: boolean;
  @IsOptional() @IsBoolean() trackAuditHistory?: boolean;
}

export class UpdateAuditSettingsDto {
  @IsOptional() @IsBoolean() aiEnabled?: boolean;
  @IsOptional() @IsString() aiModel?: string;
  @IsOptional() @IsBoolean() anonymousPreviewEnabled?: boolean;
  @IsOptional() @IsInt() @Min(0) @Max(100) freeAuditCount?: number;
  @IsOptional() @IsInt() @Min(0) @Max(3650) auditValidityDays?: number;

  @IsOptional() @ValidateNested() @Type(() => WeightsDto) weights?: WeightsDto;
  @IsOptional() @ValidateNested() @Type(() => ThresholdsDto) thresholds?: ThresholdsDto;
  @IsOptional() @ValidateNested() @Type(() => ScoreWeightsDto) scoreWeights?: ScoreWeightsDto;

  @IsOptional() @IsBoolean() version2Enabled?: boolean;
  @IsOptional() @IsString() version1Name?: string;
  @IsOptional() @IsString() version2Name?: string;

  @IsOptional() @ValidateNested() @Type(() => PlatformsEnabledDto) platformsEnabled?: PlatformsEnabledDto;

  @IsOptional() @IsInt() @Min(0) @Max(365) reanalysisCooldownDays?: number;
  @IsOptional() @IsNumber() @Min(0) reanalysisFeeRupees?: number;

  @IsOptional() @IsBoolean() nightlyReauditEnabled?: boolean;
  @IsOptional() @IsInt() @Min(0) @Max(23) nightlyReauditCronHour?: number;
  @IsOptional() @IsInt() @Min(0) youtubeApiQuotaGuardPerDay?: number;

  @IsOptional() @ValidateNested() @Type(() => AnalyticsDto) analytics?: AnalyticsDto;
}
