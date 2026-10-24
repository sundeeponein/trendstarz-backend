import { CampaignsService } from "./campaigns.service";

describe("campaign product money fields", () => {
  const normalize = (data: any) =>
    (CampaignsService.prototype as any).normalizeCampaignPayload.call(
      Object.create(CampaignsService.prototype),
      data,
    );

  it("stores product value and Product + Paid cash as whole paise", () => {
    const n = normalize({ campaignType: "product", productPaymentMode: "product_plus_payment", productPaymentAmount: "50000.4", productValue: 120000 });
    expect(n.productPaymentAmount).toBe(50000);
    expect(n.productValue).toBe(120000);
  });

  it("refuses negative or nonsense amounts, unknown modes, and Product + Paid without cash", () => {
    expect(() => normalize({ productPaymentAmount: -100 })).toThrow("paise");
    expect(() => normalize({ productValue: "abc" })).toThrow("paise");
    expect(() => normalize({ productPaymentMode: "free_money" })).toThrow("productPaymentMode");
    expect(() => normalize({ productPaymentMode: "product_plus_payment", productPaymentAmount: 0 })).toThrow("cash amount");
  });
});
