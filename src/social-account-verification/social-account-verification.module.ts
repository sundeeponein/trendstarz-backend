import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { UserSchema } from "../database/schemas/profile.schemas";
import {
  SocialAccountReviewSchema,
  SocialAccountVerificationSchema,
} from "../database/schemas/social-account-verification.schema";
import { SocialAccountVerificationService } from "./social-account-verification.service";

/**
 * Stage 3A-1: per-social-account admin verification. Internal-only — the admin
 * endpoints live on AdminUserTableController; profile save paths use reconcile().
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      {
        name: "SocialAccountVerification",
        schema: SocialAccountVerificationSchema,
        collection: "social_account_verifications",
      },
      {
        name: "SocialAccountReview",
        schema: SocialAccountReviewSchema,
        collection: "social_account_reviews",
      },
      { name: "User", schema: UserSchema, collection: "users" },
    ]),
  ],
  providers: [SocialAccountVerificationService],
  exports: [SocialAccountVerificationService],
})
export class SocialAccountVerificationModule {}
