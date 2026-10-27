import { CampaignsService } from "./campaigns.service";

/** /campaigns/brand-name/<name> follows the brand page's rule: who may open that brand. */
describe("public campaigns of one brand", () => {
  const make = (brand: any) => {
    const s: any = Object.create(CampaignsService.prototype);
    s.brandModel = { findOne: () => ({ select: () => ({ lean: async () => brand }) }) };
    const find = jest.fn(() => ({ select: () => ({ sort: () => ({ lean: async () => [{ title: "Live campaign" }] }) }) }));
    s.campaignModel = { find };
    return { service: s as CampaignsService, find };
  };
  const guest = null;
  const member = { userId: "u1", role: "influencer" };
  const owner = { userId: "b1", role: "brand" };

  it.each([
    ["public brand", { _id: "b1", status: "accepted" }, [1, 1, 1]],
    ["members-only brand", { _id: "b1", status: "accepted", profileVisibility: "MEMBERS_ONLY" }, [0, 1, 1]],
    ["private brand", { _id: "b1", status: "accepted", profileVisibility: "PRIVATE" }, [0, 0, 1]],
    ["pending brand", { _id: "b1", status: "pending" }, [0, 0, 1]],
    ["deleted brand", { _id: "b1", status: "deleted", isDeleted: true }, [0, 0, 1]],
    ["no such brand", null, [0, 0, 0]],
  ])("%s → guest, member, owner see this many campaigns", async (_label, brand, expected) => {
    const counts: number[] = [];
    for (const viewer of [guest, member, owner]) {
      const { service } = make(brand);
      counts.push((await service.findByBrandName("Some Brand", viewer)).length);
    }
    expect(counts).toEqual(expected);
  });
});
