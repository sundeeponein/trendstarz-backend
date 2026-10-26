import { Body, Controller, Get, Post, Query, Req, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { RolesGuard } from "../auth/roles.guard";
import { DataIntegrityService } from "./data-integrity.service";
import { DatabaseBackupService } from "./database-backup.service";

/** Admin "Data health" page: latest nightly result, or run the checks now. */
@Controller("admin/data-integrity")
@UseGuards(JwtAuthGuard, RolesGuard)
export class DataIntegrityController {
  constructor(
    private readonly service: DataIntegrityService,
    private readonly backups: DatabaseBackupService,
  ) {}

  @Get()
  latest() {
    return this.service.report();
  }

  @Post("run")
  runNow() {
    return this.service.run("admin");
  }

  /** Mark one flagged record as explained (body: { check, ref, reason }). */
  @Post("explain")
  explain(
    @Req() req: any,
    @Body() body: { check?: string; ref?: string; reason?: string },
  ) {
    return this.service.explain(body, String(req.user?.userId || ""));
  }

  /** Captured Razorpay payments of the last ?days=N (default 7, max 60) that TrendStarZ didn't complete. */
  @Get("razorpay-reconcile")
  reconcile(@Query("days") days?: string) {
    return this.service.reconcileRazorpay(Number(days) || 7);
  }

  /** Live accounts whose email Brevo won't deliver to (bounced, complained, unsubscribed). */
  @Get("email-blocks")
  emailBlocks() {
    return this.service.emailBlocks();
  }

  /** Firebase logins vs TrendStarZ accounts: mismatched links, logins kept after deletion. */
  @Get("firebase-reconcile")
  firebaseReconcile() {
    return this.service.reconcileFirebase();
  }

  /** Nightly encrypted backups: recent runs and stored files (10-minute download links). */
  @Get("backups")
  backupOverview() {
    return this.backups.overview();
  }

  @Post("backups/run")
  backupNow() {
    return this.backups.runBackup("admin");
  }

  /** Restore test: download the newest backup and prove it reads back in full. */
  @Post("backups/verify")
  verifyBackup() {
    return this.backups.verifyLatest("admin");
  }

  @Get("explanations")
  explanations() {
    return this.service.explanations();
  }
}
