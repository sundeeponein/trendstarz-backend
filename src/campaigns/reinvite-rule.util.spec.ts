import {
  ACTIVE_INVITE_STATUSES,
  INACTIVE_INVITE_STATUSES,
  reinviteBlockReason,
} from "./reinvite-rule.util";
import { CampaignInviteSchema } from "../database/schemas/campaign-invite.schema";

describe("reinviteBlockReason", () => {
  it("allows a creator who was never invited", () => {
    expect(reinviteBlockReason([])).toBeNull();
  });

  it("blocks while any invite is still in play", () => {
    expect(
      reinviteBlockReason([{ status: "withdrawn" }, { status: "pending" }]),
    ).toMatch(/already been invited/);
  });

  it("blocks a creator who declined", () => {
    expect(reinviteBlockReason([{ status: "declined" }])).toMatch(/declined/);
  });

  it("allows re-inviting after a withdrawn/expired invite", () => {
    expect(reinviteBlockReason([{ status: "withdrawn" }])).toBeNull();
  });

  it("covers every CampaignInvite status exactly once (keeps the partial unique index honest)", () => {
    const schemaStatuses = [
      ...((CampaignInviteSchema.path("status") as any).enumValues as string[]),
    ].sort();
    expect(
      [...ACTIVE_INVITE_STATUSES, ...INACTIVE_INVITE_STATUSES].sort(),
    ).toEqual(schemaStatuses);
  });
});
