import { Controller, Get, Req, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "./auth/jwt-auth.guard";
import { RolesGuard } from "./auth/roles.guard";

@Controller("health")
export class HealthController {
  @Get()
  health() {
    return { status: "ok" };
  }

  /**
   * Admin check that per-visitor rate limits work behind the proxy: `ip` must be
   * your own public address (compare with whatismyip), not a Railway/proxy address.
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Get("client-ip")
  clientIp(@Req() req: any) {
    return {
      ip: req.ip,
      forwardedFor: String(req.headers?.["x-forwarded-for"] || ""),
      trustProxy: req.app?.get?.("trust proxy") ?? null,
    };
  }
}
