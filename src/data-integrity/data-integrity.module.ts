import { Module } from "@nestjs/common";
import { DataIntegrityController } from "./data-integrity.controller";
import { DataIntegrityService } from "./data-integrity.service";
import { DatabaseBackupService } from "./database-backup.service";

@Module({
  controllers: [DataIntegrityController],
  providers: [DataIntegrityService, DatabaseBackupService],
})
export class DataIntegrityModule {}
