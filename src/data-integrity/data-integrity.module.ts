import { Module } from "@nestjs/common";
import { DataIntegrityController } from "./data-integrity.controller";
import { ClientErrorsController } from "./client-errors.controller";
import { DataIntegrityService } from "./data-integrity.service";
import { DatabaseBackupService } from "./database-backup.service";
import { FirebaseAdminService } from "../utils/firebase-admin.service";

@Module({
  controllers: [DataIntegrityController, ClientErrorsController],
  providers: [DataIntegrityService, DatabaseBackupService, FirebaseAdminService],
})
export class DataIntegrityModule {}
