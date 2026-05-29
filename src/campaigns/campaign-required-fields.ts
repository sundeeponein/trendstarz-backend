/**
 * Shared required-field rules for campaign/collab payloads.
 *
 * Single source of truth used by:
 *   - Frontend: `campaign-form.component.ts` -> `applyCampaignTypeValidators`
 *   - Backend:  `campaigns.service.ts`        -> `assertRequiredFieldsForCampaign`
 *
 * Keep this file content-identical between the frontend and backend copies.
 */

export type CampaignRequiredFieldsCtx = {
  campaignType: string;
  ownerType?: "brand" | "photographer";
  inviteRecipientRole?: "influencer" | "photographer";
  productPaymentMode?: string;
  shootLocationType?: string;
};

export function getRequiredFields(ctx: CampaignRequiredFieldsCtx): string[] {
  const t = String(ctx.campaignType || "");
  const isPhotographerCreator = ctx.ownerType === "photographer";
  const isInvitingPhotographers = ctx.inviteRecipientRole === "photographer";

  const isPaid = t === "paid_collab";
  const isProduct = t === "product";
  const isLocation = t === "invite_location";
  const isPayToJoin = t === "pay_to_join";
  const isCreativeProject = t === "creative_project";

  const required: string[] = [];

  // Flat payout requirement is role/type aware:
  // - paid_collab: flat only when photographer is involved
  // - invite_location + pay_to_join: always flat
  // - creative_project: flat for photographer-led collaborations
  const paidNeedsFlat = isPaid && (isPhotographerCreator || isInvitingPhotographers);
  const creativeNeedsFlat = isCreativeProject && isPhotographerCreator;
  if (paidNeedsFlat || isPayToJoin || isLocation || creativeNeedsFlat) {
    required.push("pricePerInfluencer");
  }

  // Location event fields.
  if (isLocation) {
    required.push(
      "venueAddress",
      "venueState",
      "venueDistrict",
      "venueCity",
      "inviteBenefits",
    );
  }

  // Pay-to-join benefits.
  if (isPayToJoin) required.push("payToJoinBenefits");

  // Product collab fields.
  if (isProduct) {
    required.push("productDescription");
    if (ctx.productPaymentMode === "product_plus_payment") {
      required.push("productPaymentAmount");
    }
  }

  // Shoot location: required for photographer-led collabs, and for
  // brand-to-photographer invites when the requirement is Paid Collab
  // or Invite-to-Location (NOT Product Collab — product ships to photographer).
  const needsShootLocation =
    isPhotographerCreator || (isInvitingPhotographers && (isPaid || isLocation));
  if (needsShootLocation) {
    required.push("shootLocationType");
    // 'remote' shoot type (creative_project only) skips the physical address.
    if (ctx.shootLocationType !== "remote") {
      required.push("shootLocationAddress");
    }
  }

  return required;
}
