import { Controller, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { RolesGuard } from "../auth/roles.guard";
import { PlansService } from "./plans.service";
import * as fs from "fs";
import * as path from "path";

@Controller("plans")
export class PlansConfigController {
  constructor(private readonly plansService: PlansService) {}

  /** POST /plans/admin/load-config — load plans from config file */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Post("admin/load-config")
  async loadFromConfig() {
    try {
      const configPath = path.join(__dirname, "../../assets/plans-config.json");
      console.log("[PlansConfigController] Loading config from:", configPath);
      if (!fs.existsSync(configPath)) {
        console.error(
          "[PlansConfigController] Config file not found:",
          configPath,
        );
        return {
          success: false,
          message: `Config file not found: ${configPath}`,
        };
      }
      const configRaw = fs.readFileSync(configPath, "utf-8");
      let config;
      try {
        config = JSON.parse(configRaw);
      } catch (err) {
        console.error("[PlansConfigController] JSON parse error:", err);
        return { success: false, message: "Invalid JSON in config file" };
      }
      if (!Array.isArray(config.plans)) {
        console.error(
          "[PlansConfigController] Invalid config format: no 'plans' array",
        );
        return {
          success: false,
          message: "Invalid config format: no 'plans' array",
        };
      }
      // Remove all existing plans
      await this.plansService["planModel"].deleteMany({});
      // Insert new plans
      await this.plansService["planModel"].insertMany(config.plans);
      console.log(
        "[PlansConfigController] Plans loaded from config successfully.",
      );
      return { success: true, message: "Plans loaded from config" };
    } catch (err) {
      console.error("[PlansConfigController] Unexpected error:", err);
      const errorMsg =
        err && (err as Error).message
          ? (err as Error).message
          : "Unknown error";
      return {
        success: false,
        message: errorMsg,
      };
    }
  }
}
