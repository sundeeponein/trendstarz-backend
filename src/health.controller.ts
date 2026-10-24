import { Controller, Get, Header, Optional, Req, UseGuards } from "@nestjs/common";
import { InjectConnection } from "@nestjs/mongoose";
import type { Connection } from "mongoose";
import { runConfigChecks } from "./utils/config-health.util";
import { JwtAuthGuard } from "./auth/jwt-auth.guard";
import { RolesGuard } from "./auth/roles.guard";

@Controller("health")
export class HealthController {
  constructor(@Optional() @InjectConnection() private readonly connection?: Connection) {}

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

  /**
   * Admin check after a deploy or key rotation: each service's settings are
   * present and its key works (read-only live calls). Never returns secrets.
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Get("config")
  @Header("Cache-Control", "no-store")
  async config() {
    const checks = await runConfigChecks(this.connection);
    return {
      ok: checks.every((c) => c.status === "working" || c.status === "off"),
      checks,
    };
  }
}
