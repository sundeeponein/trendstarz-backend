import { Body, Controller, Get, Post, Query } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { GrowthService } from "./growth.service";

/** Public "Get a creator shortlist" form (growth plan move 2, 2026-11-16). No login. */
@Controller("shortlist-requests")
export class PublicShortlistController {
  constructor(private readonly growth: GrowthService) {}

  @Throttle({ default: { ttl: 60000, limit: 20 } })
  @Get("creator-count")
  async creatorCount(@Query("state") state: string, @Query("category") category: string) {
    return this.growth.creatorCount(state, category);
  }

  /** Signup page: the brand's details from their shortlist link (needs the private code). */
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @Get("prefill")
  async prefill(@Query("ref") ref: string) {
    return this.growth.prefill(ref);
  }

  @Throttle({ default: { ttl: 60000, limit: 3 } })
  @Post()
  async create(@Body() body: any) {
    return this.growth.createRequest(body);
  }
}
