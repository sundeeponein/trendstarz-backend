import {
  NEW_WHATSAPP_TEMPLATES,
  creatorInviteLink,
  inviteReceivedParams,
  isWhatsAppTemplateEnabled,
  whatsAppDate,
  whatsAppParam,
  whatsAppTemplateText,
} from "./whatsapp-templates";
import {
  campaignRespondBeforeLabel,
  inviteLocationLabel,
  renderInviteAcceptedOwnerMessage,
} from "../campaigns/campaign-alert-messages";

describe("WhatsApp template switches", () => {
  it("with WHATSAPP_TEMPLATES unset: older templates keep working, new ones and new uses stay off", () => {
    const env = {} as NodeJS.ProcessEnv;
    expect(isWhatsAppTemplateEnabled("campaign_posting_reminder", {}, env)).toBe(true);
    expect(isWhatsAppTemplateEnabled("premium_activated", {}, env)).toBe(false);
    expect(isWhatsAppTemplateEnabled("welcome_user", {}, env)).toBe(false);
    expect(isWhatsAppTemplateEnabled("mobile_otp_verification_reminder", { newUse: true }, env)).toBe(false);
    expect(isWhatsAppTemplateEnabled("mobile_otp_verification_reminder", {}, env)).toBe(true);
  });

  it("once set, only listed templates send (or all)", () => {
    const env = { WHATSAPP_TEMPLATES: " premium_activated, welcome_user " } as NodeJS.ProcessEnv;
    expect(isWhatsAppTemplateEnabled("premium_activated", {}, env)).toBe(true);
    expect(isWhatsAppTemplateEnabled("welcome_user", {}, env)).toBe(true);
    expect(isWhatsAppTemplateEnabled("campaign_posting_reminder", {}, env)).toBe(false);
    expect(isWhatsAppTemplateEnabled("anything", {}, { WHATSAPP_TEMPLATES: "all" } as NodeJS.ProcessEnv)).toBe(true);
  });

  it("cleans params the way Meta requires (no empty, no newlines, no 4+ spaces)", () => {
    expect(whatsAppParam("")).toBe("-");
    expect(whatsAppParam("a\nb\tc")).toBe("a b c");
    expect(whatsAppParam("a      b")).toBe("a b");
    expect(whatsAppDate("2027-10-31T00:00:00Z")).toBe("31 Oct 2027");
  });

  it("every new template's {{n}} placeholders match its param list, and stays non-promotional", () => {
    for (const t of NEW_WHATSAPP_TEMPLATES) {
      const used = [...t.body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));
      expect(Math.max(...used)).toBe(t.params.length);
      expect(new Set(used).size).toBe(t.params.length);
      expect(t.body).not.toMatch(/₹|offer|discount|% off/i);
    }
  });
});

describe("manual WhatsApp text matches the automatic template", () => {
  it("fills each {{n}} with the cleaned param, in order", () => {
    const params = inviteReceivedParams({
      creatorName: "Asha",
      senderName: "Glow Co",
      senderRole: "brand",
      campaignTitle: "Diwali\nlaunch",
      location: "No visit needed",
      respondBefore: "Oct 12, 2026",
      inviteUrl: creatorInviteLink("influencer", "abc123", { FRONTEND_URL: "https://trendstarz.in/" } as any),
    });
    expect(params).toEqual(["Asha", "Glow Co", "Brand", "Diwali\nlaunch", "No visit needed", "Oct 12, 2026", "https://trendstarz.in/influencer-dashboard?invite=abc123"]);
    const text = whatsAppTemplateText("campaign_invite_received", params);
    expect(text).toContain('Hi Asha, you have a new campaign invite from Glow Co (Brand) for "Diwali launch".');
    expect(text).toContain("📍 Location: No visit needed\n📅 Respond Before: Oct 12, 2026");
    expect(text).toContain("not an Instagram native Collab post invitation");
    expect(text).toContain("respond here: https://trendstarz.in/influencer-dashboard?invite=abc123");
    expect(text).not.toMatch(/\{\{\d+\}\}/);
  });

  it("covers every step of the invite flow, including the older accepted template", () => {
    for (const name of [
      "campaign_invite_received",
      "campaign_invite_accepted_owner",
      "campaign_payment_received_host",
      "campaign_start_posting",
    ]) {
      expect(whatsAppTemplateText(name, ["a", "b", "c", "d", "e", "f", "g"])).not.toBe("");
    }
    expect(
      renderInviteAcceptedOwnerMessage({ ownerName: "Glow Co", recipientName: "Asha", campaignTitle: "Diwali", campaignUrl: "https://x/campaigns" }),
    ).toBe(
      whatsAppTemplateText("campaign_invite_accepted_owner", ["Glow Co", "Asha", "Diwali", "https://x/campaigns"]),
    );
  });

  it("links a photographer to their own dashboard, and falls back without an invite id", () => {
    const env = { FRONTEND_URL: "https://trendstarz.in" } as any;
    expect(creatorInviteLink("photographer", "x1", env)).toBe("https://trendstarz.in/photographer-dashboard?invite=x1");
    expect(creatorInviteLink("influencer", null, env)).toBe("https://trendstarz.in/influencer-dashboard");
  });
});

describe("campaign invite location and respond-before lines", () => {
  it("names the venue's area for a location visit and 'No visit needed' otherwise", () => {
    const visit = {
      campaignType: "invite_location",
      venueName: "Cafe Bloom",
      venueAddress: "Road No. 36, Jubilee Hills",
      venueGoogleMapUrl: "https://maps.google.com/?q=cafe",
      venueCity: "Hyderabad",
      venueDistrict: "hyderabad",
      venueState: "Telangana",
      targetState: "Telangana",
    };
    // Venue name, address and map stay hidden until the creator accepts.
    expect(inviteLocationLabel(visit)).toBe("Hyderabad, Telangana");
    expect(inviteLocationLabel({ campaignType: "invite_location", targetDistrict: "Warangal", targetState: "Telangana" })).toBe(
      "Warangal, Telangana",
    );
    for (const campaignType of ["paid_collab", "product"]) {
      expect(inviteLocationLabel({ campaignType, targetState: "Telangana" })).toBe("No visit needed");
    }
  });

  it("uses the accept-by date, falling back to the end date", () => {
    expect(campaignRespondBeforeLabel({ acceptanceDeadline: "2026-10-12T18:29:00Z" })).toBe(
      whatsAppDate(new Date("2026-10-12T18:29:00Z")),
    );
    expect(campaignRespondBeforeLabel({})).toBe("Not specified");
  });
});
