import { NEW_WHATSAPP_TEMPLATES, isWhatsAppTemplateEnabled, whatsAppDate, whatsAppParam } from "./whatsapp-templates";

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
