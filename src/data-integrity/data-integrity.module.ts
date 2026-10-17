import { Module } from "@nestjs/common";
import { DataIntegrityController } from "./data-integrity.controller";
import { DataIntegrityService } from "./data-integrity.service";

@Module({
  controllers: [DataIntegrityController],
  providers: [DataIntegrityService],
})
export class DataIntegrityModule {}
