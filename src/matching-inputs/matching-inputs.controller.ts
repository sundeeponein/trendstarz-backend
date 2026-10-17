import { Controller, Get, Param, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { RolesGuard } from "../auth/roles.guard";
import { MatchingInputsService } from "./matching-inputs.service";

/**
 * Stage 3B-1 — inspect normalized matching inputs. Admin-only, read-only;
 * for reviewing the data contract before Stage 3B-2. No scores.
 */
@Controller("admin/matching-inputs")
@UseGuards(JwtAuthGuard, RolesGuard)
export class MatchingInputsController {
  constructor(private readonly service: MatchingInputsService) {}

  @Get("creators/:type/:id")
  creator(@Param("type") type: string, @Param("id") id: string) {
    return this.service.forCreator(type, id);
  }

  @Get("campaigns/:id")
  campaign(@Param("id") id: string) {
    return this.service.forCampaign(id);
  }
}
