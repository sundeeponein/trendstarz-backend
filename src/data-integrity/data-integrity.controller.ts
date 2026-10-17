import { Controller, Get, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { RolesGuard } from "../auth/roles.guard";
import { DataIntegrityService } from "./data-integrity.service";

/** Admin "Data health" page: latest nightly result, or run the checks now. */
@Controller("admin/data-integrity")
@UseGuards(JwtAuthGuard, RolesGuard)
export class DataIntegrityController {
  constructor(private readonly service: DataIntegrityService) {}

  @Get()
  latest() {
    return this.service.report();
  }

  @Post("run")
  runNow() {
    return this.service.run("admin");
  }
}
