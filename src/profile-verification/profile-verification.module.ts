import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import {
  BrandSchema,
  InfluencerSchema,
  PhotographerSchema,
  UserSchema,
} from "../database/schemas/profile.schemas";
import { PaymentSchema } from "../database/schemas/payment.schema";
import { ProfileFlagSchema } from "../database/schemas/profile-flag.schema";
import { ProfileVerificationController } from "./profile-verification.controller";
import { ProfileVerificationService } from "./profile-verification.service";
import { WhatsAppModule } from "../whatsapp/whatsapp.module";

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: "ProfileFlag", schema: ProfileFlagSchema, collection: "profile_flags" },
      { name: "Influencer", schema: InfluencerSchema, collection: "influencers" },
      { name: "Brand", schema: BrandSchema, collection: "brands" },
      { name: "Photographer", schema: PhotographerSchema, collection: "photographers" },
      { name: "User", schema: UserSchema, collection: "users" },
      { name: "Payment", schema: PaymentSchema, collection: "payments" },
    ]),
    WhatsAppModule,
  ],
  controllers: [ProfileVerificationController],
  providers: [ProfileVerificationService],
  exports: [ProfileVerificationService],
})
export class ProfileVerificationModule {}
