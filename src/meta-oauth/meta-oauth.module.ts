import { Module } from "@nestjs/common";
import { MetaOAuthService } from "./meta-oauth.service";

@Module({
  providers: [MetaOAuthService],
  exports: [MetaOAuthService],
})
export class MetaOAuthModule {}
