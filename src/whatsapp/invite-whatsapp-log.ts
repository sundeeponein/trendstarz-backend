import { Schema } from "mongoose";

/**
 * Per-invite record of the campaign WhatsApp messages that went out — the
 * automatic template sends and the admin's manual "Send via WhatsApp" — so the
 * admin's message buttons can show "Sent" and not send the same message twice
 * (2026-11-13). Keys match the admin modal's HostShareMessageType.
 */
export const INVITE_WHATSAPP_MESSAGE_TYPES = [
  "accepted",
  "submitted",
  "paymentReceived",
  "startWork",
  "productShipped",
  "inviteOnly",
  "postingReminder",
  // Payout released — admin's manual "Payment" message to the creator.
  "payment",
] as const;

export type InviteWhatsAppMessageType = (typeof INVITE_WHATSAPP_MESSAGE_TYPES)[number];

export function isInviteWhatsAppMessageType(value: unknown): value is InviteWhatsAppMessageType {
  return (INVITE_WHATSAPP_MESSAGE_TYPES as readonly string[]).includes(String(value));
}

const entry = new Schema(
  {
    count: { type: Number, min: 0, default: 0 },
    lastSentAt: { type: Date },
    lastVia: { type: String, enum: ["auto", "manual"] },
  },
  { _id: false },
);

export const InviteWhatsAppLogSchemaDef = Object.fromEntries(
  INVITE_WHATSAPP_MESSAGE_TYPES.map((t) => [t, { type: entry, default: undefined }]),
);

/** Stamps one send. Best-effort: a failure here never blocks the send itself. */
export async function recordInviteWhatsApp(
  inviteModel: { updateOne: (...args: any[]) => any },
  inviteId: unknown,
  type: InviteWhatsAppMessageType,
  via: "auto" | "manual",
  at: Date = new Date(),
): Promise<void> {
  const id = String(inviteId || "").trim();
  if (!id || !isInviteWhatsAppMessageType(type)) return;
  try {
    await inviteModel.updateOne(
      { _id: id },
      {
        $inc: { [`whatsappLog.${type}.count`]: 1 },
        $set: { [`whatsappLog.${type}.lastSentAt`]: at, [`whatsappLog.${type}.lastVia`]: via },
      },
    );
  } catch {
    // non-critical
  }
}
