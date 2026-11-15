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

/**
 * How many times each message may be sent in total (automatic + admin), 2026-11-15.
 * Submitted up to 2 (re-send if the host hasn't seen it); Posting Reminder up to 5,
 * at most one per India day and not after the post date; everything else once.
 * The only copy: the admin screen gets it from GET /admin/campaigns/:id/share-messages
 * (whatsappSendLimits) and locks its buttons from it.
 */
export const INVITE_WHATSAPP_SEND_LIMITS: Record<InviteWhatsAppMessageType, number> = {
  accepted: 1,
  submitted: 2,
  paymentReceived: 1,
  startWork: 1,
  productShipped: 1,
  inviteOnly: 1,
  postingReminder: 5,
  payment: 1,
};

const IST_OFFSET_MS = 330 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** 00:00 India time of the day `d` falls on. */
export function startOfIstDay(d: Date): Date {
  return new Date(Math.floor((d.getTime() + IST_OFFSET_MS) / DAY_MS) * DAY_MS - IST_OFFSET_MS);
}

/** True when `now` is on an India day after the post date's India day. */
export function isAfterPostDateIst(selectedPostDate: unknown, now: Date = new Date()): boolean {
  if (!selectedPostDate) return false;
  const post = new Date(selectedPostDate as any);
  if (Number.isNaN(post.getTime())) return false;
  return startOfIstDay(now).getTime() > startOfIstDay(post).getTime();
}

/**
 * Admin manual send: records it only if the message is still under its limit (and,
 * for the posting reminder, not already sent today). One atomic update, so two
 * admins / two tabs can't both get through. Returns false when refused.
 */
export async function recordManualInviteWhatsApp(
  inviteModel: { updateOne: (...args: any[]) => any },
  inviteId: unknown,
  type: InviteWhatsAppMessageType,
  at: Date = new Date(),
): Promise<boolean> {
  const id = String(inviteId || "").trim();
  if (!id || !isInviteWhatsAppMessageType(type)) return false;
  const countPath = `whatsappLog.${type}.count`;
  const lastPath = `whatsappLog.${type}.lastSentAt`;
  const filter: any = {
    _id: id,
    $and: [
      { $or: [{ [countPath]: { $exists: false } }, { [countPath]: { $lt: INVITE_WHATSAPP_SEND_LIMITS[type] } }] },
    ],
  };
  if (type === "postingReminder") {
    filter.$and.push({
      $or: [{ [lastPath]: { $exists: false } }, { [lastPath]: { $lt: startOfIstDay(at) } }],
    });
  }
  const res: any = await inviteModel.updateOne(filter, {
    $inc: { [countPath]: 1 },
    $set: { [lastPath]: at, [`whatsappLog.${type}.lastVia`]: "manual" },
  });
  return Number(res?.modifiedCount ?? res?.nModified ?? 0) > 0;
}

/** Stamps one automatic send (never limited — it already went out). Best-effort: a failure here never blocks the send itself. */
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
