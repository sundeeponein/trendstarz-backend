import { Module } from '@nestjs/common';
import { OtpController } from './otp.controller';
import { DevEmailService } from '../utils/dev-email.service';
import { SesEmailService } from '../utils/ses-email.service';

@Module({
  controllers: [OtpController],
  providers: [DevEmailService, SesEmailService],
})
export class OtpModule {}
