import axios from "axios";

export interface WhatsAppTemplateMessage {
  /** Destination number in any of the formats stored on our profiles (10-digit, 91-prefixed, or +91-prefixed). */
  to: string;
  templateName: string;
  languageCode?: string;
  /** Values for the template's {{1}}, {{2}}, ... body placeholders, in order. */
  bodyParams?: string[];
}

const warnedMissingConfig = new Set<string>();

function warnOnce(key: string, message: string) {
  if (warnedMissingConfig.has(key)) return;
  warnedMissingConfig.add(key);
  console.warn(message);
}

/** Meta expects the destination without "+" or leading zeros, prefixed with the country code. */
function toE164Digits(value: unknown): string {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length === 10) return `91${digits}`;
  return digits;
}

/**
 * Sends a pre-approved WhatsApp template message via the Meta Cloud API.
 * Business-initiated messages must use an approved template — free-form text
 * is only allowed as a reply within a customer-opened 24h session.
 */
export async function sendWhatsAppTemplateMessage({
  to,
  templateName,
  languageCode = "en",
  bodyParams = [],
}: WhatsAppTemplateMessage) {
  const token = process.env.WHATSAPP_CLOUD_API_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const apiVersion = process.env.WHATSAPP_API_VERSION || "v21.0";

  if (!token || !phoneNumberId) {
    warnOnce(
      "whatsapp:config",
      "[sendWhatsAppTemplateMessage] Skipping WhatsApp send because WHATSAPP_CLOUD_API_TOKEN or WHATSAPP_PHONE_NUMBER_ID is not set.",
    );
    return { skipped: true, reason: "WhatsApp Cloud API is not configured" };
  }

  const destination = toE164Digits(to);
  if (!destination) {
    return { skipped: true, reason: "Missing/invalid destination number" };
  }

  const payload = {
    messaging_product: "whatsapp",
    to: destination,
    type: "template",
    template: {
      name: templateName,
      language: { code: languageCode },
      components: bodyParams.length
        ? [
            {
              type: "body",
              parameters: bodyParams.map((text) => ({ type: "text", text })),
            },
          ]
        : undefined,
    },
  };

  const res = await axios.post(
    `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`,
    payload,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    },
  );
  return res.data;
}
