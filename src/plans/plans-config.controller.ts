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
    const configPath = path.join(__dirname, "../../assets/plans-config.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    if (!Array.isArray(config.plans)) {
      return { success: false, message: "Invalid config format" };
    }
    // Remove all existing plans
    await this.plansService["planModel"].deleteMany({});
    // Insert new plans
    await this.plansService["planModel"].insertMany(config.plans);
    return { success: true, message: "Plans loaded from config" };
  }
}
