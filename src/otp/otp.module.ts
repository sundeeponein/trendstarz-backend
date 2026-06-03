import { Module } from "@nestjs/common";
import { OtpController } from "./otp.controller";
import { DummySmsProvider } from "../services/smsProvider.service";

@Module({
  controllers: [OtpController],
  providers: [
    {
      provide: "SMS_PROVIDER",
      useClass: DummySmsProvider,
    },
  ],
})
export class OtpModule {}
