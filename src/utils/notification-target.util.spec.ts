import { creatorNotificationUrl } from "./notification-target.util";

describe("creator notification links", () => {
  it("sends dashboard links to the part the notification is about", () => {
    expect(creatorNotificationUrl("/influencer-dashboard", "Payment verified ✅")).toBe("/influencer-dashboard?section=payments");
    expect(creatorNotificationUrl("/photographer-dashboard", "Payout sent")).toBe("/photographer-dashboard?section=payments");
    expect(creatorNotificationUrl("/influencer-dashboard", "Revised offer received")).toBe("/influencer-dashboard?section=invites");
    expect(creatorNotificationUrl("/influencer-dashboard", "Participation Closed")).toBe("/campaigns?tab=campaigns");
  });
  it("keeps links that are already specific, and other pages", () => {
    expect(creatorNotificationUrl("/influencer-dashboard?invite=abc", "New Campaign Invite")).toBe("/influencer-dashboard?invite=abc");
    expect(creatorNotificationUrl("/campaign-management", "Payment received")).toBe("/campaign-management");
    expect(creatorNotificationUrl("/influencer-dashboard", "Welcome")).toBe("/influencer-dashboard");
  });
});
