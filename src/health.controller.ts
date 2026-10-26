import { Controller, Get, Header, Optional, Req, ServiceUnavailableException, UseGuards } from "@nestjs/common";
import { InjectConnection } from "@nestjs/mongoose";
import type { Connection } from "mongoose";
import { runConfigChecks } from "./utils/config-health.util";
import { JwtAuthGuard } from "./auth/jwt-auth.guard";
import { RolesGuard } from "./auth/roles.guard";

@Controller("health")
export class HealthController {
  constructor(@Optional() @InjectConnection() private readonly connection?: Connection) {}

  /**
   * For uptime monitors: "ok" only when the API AND the database answer. Before, it
   * said "ok" even with the database down, so a monitor would show "up" while every
   * real page failed. 503 if MongoDB doesn't answer a ping within 3 seconds.
   */
  @Get()
  @Header("Cache-Control", "no-store")
  async health() {
    const ping = this.connection?.db?.admin().ping();
    const ok = await Promise.race([
      Promise.resolve(ping).then(() => true, () => false),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000)),
    ]);
    if (!ping || !ok) throw new ServiceUnavailableException({ status: "down", db: "unreachable" });
    return { status: "ok", db: "ok" };
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
