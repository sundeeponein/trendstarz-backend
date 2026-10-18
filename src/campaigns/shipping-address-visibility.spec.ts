import { CampaignInvitesService } from "./campaign-invites.service";

const address = { contactName: "Asha", line1: "12 MG Road", city: "Hyderabad", pincode: "500001" };

describe("shipping address visibility (forParty)", () => {
  it("is hidden from the host until the collaboration is confirmed", () => {
    const out = CampaignInvitesService.forParty({ status: "accepted", shippingAddress: address }, "host");
    expect(out.shippingAddress).toBeUndefined();
  });

  it("is shown to the host once the platform fee is paid or contact is unlocked", () => {
    expect(CampaignInvitesService.forParty({ status: "accepted", platformFeePaidAt: new Date(), shippingAddress: address }, "host").shippingAddress).toEqual(address);
    expect(CampaignInvitesService.forParty({ status: "accepted", unlocked: true, shippingAddress: address }, "host").shippingAddress).toEqual(address);
  });

  it("the creator always sees their own address", () => {
    expect(CampaignInvitesService.forParty({ status: "accepted", shippingAddress: address }, "creator").shippingAddress).toEqual(address);
  });
});
