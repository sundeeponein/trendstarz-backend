import { Injectable } from "@nestjs/common";
import { InjectConnection } from "@nestjs/mongoose";
import { Connection } from "mongoose";
import {
  EvidenceQualityReport,
  buildEvidenceQualityReport,
} from "./evidence-quality.analysis";

/**
 * Stage 3D-1m — loads the evidence (read-only, one find per collection, no
 * per-profile queries) and hands it to the pure report builder. Never writes,
 * never calls a platform API, never persists the report. Profile reads use an
 * inclusion projection (no contact details, passwords or payout data), and
 * Meta connections are read WITHOUT their access token.
 */
const NOT_DELETED = { isDeleted: { $ne: true } };

const PROFILE_FIELDS = {
  _id: 1,
  status: 1,
  isDeleted: 1,
  accountStatus: 1,
  isEmailVerified: 1,
  isMobileVerified: 1,
  verificationStatus: 1,
  verifiedByTrendStarz: 1,
  profileVisibility: 1,
  profileImages: 1,
  location: 1,
  categories: 1,
  skills: 1,
  languages: 1,
  socialMedia: 1,
  collaborationAvailability: 1,
  lastLoginAt: 1,
  lastOpenedAt: 1,
};

@Injectable()
export class EvidenceQualityService {
  constructor(@InjectConnection() private readonly connection: Connection) {}

  async getReport(asOf = new Date()): Promise<EvidenceQualityReport> {
    const col = (name: string) => this.connection.collection(name);
    const [
      influencers,
      photographers,
      verifications,
      observations,
      connections,
      campaigns,
      events,
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
      col("campaigns").find({}).toArray(),
      col("platform_events")
        .find(
          {},
          {
            projection: {
              _id: 0,
              eventType: 1,
              influencerId: 1,
              "metadata.source": 1,
            },
          },
        )
        .toArray(),
    ]);
    return buildEvidenceQualityReport({
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
      campaigns,
      events: events as any,
    });
  }
}
