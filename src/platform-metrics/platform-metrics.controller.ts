import {
  BadRequestException,
  Controller,
  Get,
  Query,
  UseGuards,
} from "@nestjs/common";
import { Types } from "mongoose";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { RolesGuard } from "../auth/roles.guard";
import { MetricsWindow, WINDOW_KEYS } from "./metrics.analysis";
import { PlatformMetricsService } from "./platform-metrics.service";

const MAX_LIMIT = 200;

function parseWindow(raw?: string): MetricsWindow {
  const key = (raw || "last30Days") as MetricsWindow;
  if (!WINDOW_KEYS.includes(key)) {
    throw new BadRequestException(
      `window must be one of: ${WINDOW_KEYS.join(", ")}`,
    );
  }
  return key;
}

function parsePage(limitRaw?: string, offsetRaw?: string) {
  const limit = limitRaw === undefined ? 50 : Number(limitRaw);
  const offset = offsetRaw === undefined ? 0 : Number(offsetRaw);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new BadRequestException(`limit must be an integer 1–${MAX_LIMIT}`);
  }
  if (!Number.isInteger(offset) || offset < 0)
    throw new BadRequestException("offset must be a non-negative integer");
  return { limit, offset };
}

function parseId(name: string, raw?: string): string | undefined {
  if (raw === undefined || raw === "") return undefined;
  if (!Types.ObjectId.isValid(raw))
    throw new BadRequestException(`${name} must be a valid id`);
  return raw;
}

function parseEnum<T extends string>(
  name: string,
  raw: string | undefined,
  allowed: readonly T[],
): T | undefined {
  if (raw === undefined || raw === "") return undefined;
  if (!allowed.includes(raw as T))
    throw new BadRequestException(
      `${name} must be one of: ${allowed.join(", ")}`,
    );
  return raw as T;
}

/**
 * Stage 2B — read-only, descriptive marketplace metrics (no scores, no rankings).
 * Admin-only, same guards as the other admin routes. Ids and counts only.
 */
@Controller("admin/platform-metrics")
@UseGuards(JwtAuthGuard, RolesGuard)
export class PlatformMetricsController {
  constructor(private readonly metrics: PlatformMetricsService) {}

  @Get("overview")
  overview(@Query("window") window?: string) {
    return this.metrics.overview(parseWindow(window));
  }

  @Get("timeseries")
  timeSeries(@Query("window") window?: string) {
    return this.metrics.timeSeries(parseWindow(window));
  }

  @Get("creators")
  creators(
    @Query("window") window?: string,
    @Query("role") role?: string,
    @Query("limit") limit?: string,
    @Query("offset") offset?: string,
  ) {
    return this.metrics.creators(parseWindow(window), {
      role: parseEnum("role", role, ["influencer", "photographer"] as const),
      ...parsePage(limit, offset),
    });
  }

  @Get("owners")
  owners(
    @Query("window") window?: string,
    @Query("ownerType") ownerType?: string,
    @Query("limit") limit?: string,
    @Query("offset") offset?: string,
  ) {
    return this.metrics.owners(parseWindow(window), {
      ownerType: parseEnum("ownerType", ownerType, [
        "brand",
        "photographer",
      ] as const),
      ...parsePage(limit, offset),
    });
  }

  @Get("campaigns")
  campaigns(
    @Query("window") window?: string,
    @Query("limit") limit?: string,
    @Query("offset") offset?: string,
  ) {
    return this.metrics.campaigns(
      parseWindow(window),
      parsePage(limit, offset),
    );
  }

  @Get("relationships")
  relationships(
    @Query("creatorId") creatorId?: string,
    @Query("campaignId") campaignId?: string,
    @Query("limit") limit?: string,
    @Query("offset") offset?: string,
  ) {
    return this.metrics.relationships({
      creatorId: parseId("creatorId", creatorId),
      campaignId: parseId("campaignId", campaignId),
      ...parsePage(limit, offset),
    });
  }

  @Get("attribute-coverage")
  attributeCoverage() {
    return this.metrics.attributeCoverage();
  }
}
