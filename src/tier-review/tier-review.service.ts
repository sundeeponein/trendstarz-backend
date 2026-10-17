import { Injectable } from "@nestjs/common";
import { InjectConnection } from "@nestjs/mongoose";
import { Connection } from "mongoose";
import { TierReviewQuery, tierReviewQueue } from "./tier-review.analysis";

const NOT_DELETED = { isDeleted: { $ne: true } };

/** Only what the queue and the approved-creator check need — no contact or payout data. */
const PROFILE_FIELDS = {
  _id: 1,
  name: 1,
  username: 1,
  createdAt: 1,
  status: 1,
  isDeleted: 1,
  accountStatus: 1,
  isEmailVerified: 1,
  isMobileVerified: 1,
  verificationStatus: 1,
  verifiedByTrendStarz: 1,
  profileVisibility: 1,
  socialMedia: 1,
};

/**
 * Stage 3D-1b — loads the tier review queue (read-only: one find per collection,
 * Meta connections WITHOUT their token) and hands it to the pure builder.
 * Decisions are made through the existing tier-verification route.
 */
@Injectable()
export class TierReviewService {
  constructor(@InjectConnection() private readonly connection: Connection) {}

  async getQueue(query: TierReviewQuery, asOf = new Date()) {
    const col = (name: string) => this.connection.collection(name);
    const [
      influencers,
      photographers,
      verifications,
      observations,
      connections,
    ] = await Promise.all([
      col("influencers")
        .find(NOT_DELETED, { projection: PROFILE_FIELDS })
        .toArray(),
      col("photographers")
        .find(NOT_DELETED, { projection: PROFILE_FIELDS })
        .toArray(),
      col("social_account_verifications").find({}).toArray(),
      col("social_account_observations").find({}).toArray(),
      col("social_oauth_connections")
        .find(
          { revokedAt: null, accessToken: { $exists: true, $nin: [null, ""] } },
          {
            projection: {
              _id: 0,
              userId: 1,
              userType: 1,
              platform: 1,
              instagramBusinessAccountId: 1,
            },
          },
        )
        .toArray(),
    ]);
    return tierReviewQueue(
      {
        asOf,
        creators: [
          ...influencers.map((profile) => ({
            profileType: "Influencer" as const,
            profile,
          })),
          ...photographers.map((profile) => ({
            profileType: "Photographer" as const,
            profile,
          })),
        ],
        verifications,
        observations,
        connections: connections as any,
      },
      query,
    );
  }
}
