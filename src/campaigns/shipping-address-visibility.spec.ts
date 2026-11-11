import { CampaignInvitesService } from "./campaign-invites.service";

const address = { contactName: "Asha", line1: "12 MG Road", city: "Hyderabad", pincode: "500001" };
const host = (invite: any) => CampaignInvitesService.forParty({ shippingAddress: address, ...invite }, "host");

describe("shipping address visibility (forParty)", () => {
  // 2026-11-10: the host ships before any payment step, so the address is
  // shown as soon as the creator accepts (it used to wait for fee/unlock).
  it("is shown to the host as soon as the creator accepts, through the work", () => {
    for (const status of ["accepted", "payment_confirmed", "working", "submitted", "disputed"]) {
      expect(host({ status }).shippingAddress).toEqual(address);
    }
  });

  it("is hidden from the host on declined / withdrawn invites", () => {
    expect(host({ status: "declined" }).shippingAddress).toBeUndefined();
    expect(host({ status: "withdrawn" }).shippingAddress).toBeUndefined();
  });

  it("goes with the other contact details after the post-close window", () => {
    const longAgo = new Date(Date.now() - 365 * 24 * 3600 * 1000);
    expect(host({ status: "completed", completedAt: longAgo }).shippingAddress).toBeUndefined();
    expect(host({ status: "completed", completedAt: new Date() }).shippingAddress).toEqual(address);
  });

  it("the creator always sees their own address", () => {
    expect(CampaignInvitesService.forParty({ status: "accepted", shippingAddress: address }, "creator").shippingAddress).toEqual(address);
  });
});
