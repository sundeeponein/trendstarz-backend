import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { OtpController } from "./otp.controller";
import { OtpStoreService } from "./otp-store.service";
import { DummySmsProvider } from "../services/smsProvider.service";
import {
  OtpCodeSchema,
  OtpVerificationTokenSchema,
} from "../database/schemas/otp.schema";

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: "OtpCode", schema: OtpCodeSchema, collection: "otp_codes" },
      {
        name: "OtpVerificationToken",
        schema: OtpVerificationTokenSchema,
        collection: "otp_verification_tokens",
      },
    ]),
  ],
  controllers: [OtpController],
  providers: [
    OtpStoreService,
    {
      provide: "SMS_PROVIDER",
      useClass: DummySmsProvider,
    },
  ],
  exports: [OtpStoreService],
})
export class OtpModule {}
