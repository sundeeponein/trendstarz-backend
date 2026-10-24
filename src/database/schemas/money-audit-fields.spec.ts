import { CampaignTransactionSchema } from "./campaign-transaction.schema";

describe("money records keep which admin acted", () => {
  it("declares the admin fields (undeclared fields are silently dropped on save)", () => {
    for (const path of ["collectionVerifiedBy", "collectionRejectedBy", "collectionRejectedAt", "payoutMarkedPaidBy", "refundSentBy"]) {
      expect(CampaignTransactionSchema.path(path)).toBeDefined();
    }
  });
});
