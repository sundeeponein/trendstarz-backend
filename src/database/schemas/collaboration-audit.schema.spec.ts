import { model } from "mongoose";
import { CollaborationAuditSchema } from "./collaboration-audit.schema";

describe("collaboration audit pricing suggestion", () => {
  const Audit = model("CollaborationAuditPricingSpec", CollaborationAuditSchema);

  it("never stores a negative or non-finite suggested price", () => {
    const doc: any = new Audit({ pricingSuggestion: { reelPrice: -300, storyPrice: Infinity, videoPrice: 2700 } });
    expect(doc.pricingSuggestion.reelPrice).toBeNull();
    expect(doc.pricingSuggestion.storyPrice).toBeNull();
    expect(doc.pricingSuggestion.videoPrice).toBe(2700);
  });
});
