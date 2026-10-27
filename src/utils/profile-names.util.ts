import { BadRequestException } from "@nestjs/common";
import { Model } from "mongoose";

/**
 * One rule for the names that become profile links, for every role, at
 * sign-up and on every profile save:
 *   /influencer/<username>   /photographer/<username>   /brand/<brandUsername>
 * and the brand name (the brand page also finds a brand by its name).
 *
 * - normalizedProfileName: right form → the value to store (or a 400).
 * - profileNameTaken: does another account of the same kind already use it?
 * - checkedProfileName: both, for a profile save — an unchanged value passes
 *   as it is, so older accounts keep what they have.
 */
export type ProfileNameField = "username" | "brandUsername" | "brandName";

/** Same characters sign-up allowed photographers; "deleted-…" is what account deletion writes. */
const LINK_NAME = /^[a-z0-9_-]{1,50}$/;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Brand names compare without case, extra spaces, or hyphen-vs-space ("Vaarahi-Fashions"). */
function brandNamePattern(name: string): RegExp {
  const words = name.toLowerCase().split(/[\s-]+/).filter(Boolean).map(escapeRegex);
  return new RegExp(`^[\\s-]*${words.join("[\\s-]+")}[\\s-]*$`, "i");
}

function labelOf(field: ProfileNameField): string {
  return field === "brandUsername" ? "Brand username" : field === "brandName" ? "Brand name" : "Username";
}

/** The value to store for `field`, or a 400 saying what form it must take. */
export function normalizedProfileName(field: ProfileNameField, value: unknown): string {
  if (field === "brandName") {
    const name = String(value ?? "").replace(/\s+/g, " ").trim();
    if (!name) throw new BadRequestException("Brand name is required.");
    if (name.length > 80) throw new BadRequestException("Brand name can be at most 80 characters.");
    return name;
  }
  const name = String(value ?? "").trim().toLowerCase();
  if (!LINK_NAME.test(name) || name.startsWith("deleted-")) {
    throw new BadRequestException(
      `${labelOf(field)} can contain only lowercase letters, numbers, hyphens and underscores (up to 50).`,
    );
  }
  return name;
}

/**
 * Does another account of this kind already use `name` (from normalizedProfileName)?
 * `/brand/<x>` is looked up by name before link name, so for brands a name
 * that reads as another brand's link ("carols cosmetics" vs carols-cosmetics)
 * counts as taken, and the other way round.
 */
export async function profileNameTaken(
  model: Model<any>,
  field: ProfileNameField,
  name: string,
  exceptId?: string | null,
): Promise<boolean> {
  const exact = new RegExp(`^${escapeRegex(name)}$`, "i");
  let match: Record<string, any>;
  if (field === "brandName") {
    const asLink = name.toLowerCase().split(/[\s-]+/).filter(Boolean).join("-");
    match = { $or: [{ brandName: brandNamePattern(name) }, { brandUsername: new RegExp(`^${escapeRegex(asLink)}$`, "i") }] };
  } else if (field === "brandUsername") {
    match = { $or: [{ brandUsername: exact }, { brandName: brandNamePattern(name) }] };
  } else {
    match = { username: exact };
  }
  if (exceptId) match._id = { $ne: exceptId };
  return !!(await model.exists(match));
}

/** A profile save that sets `field`: the value to store, or a 400 (wrong form / taken). */
export async function checkedProfileName(
  model: Model<any>,
  userId: string,
  field: ProfileNameField,
  value: unknown,
): Promise<string> {
  const current: any = await model.findById(userId).select(field).lean();
  const stored = String(current?.[field] ?? "");
  // A link name never set (older brands) may stay unset: forms send it back empty.
  if (!stored && field !== "brandName" && !String(value ?? "").trim()) return stored;
  if (stored) {
    // Unchanged (ignoring case/spacing): keep it, even in a form no longer allowed.
    if (field === "brandName" && brandNamePattern(stored).test(String(value ?? ""))) {
      return normalizedProfileName(field, value);
    }
    if (field !== "brandName" && String(value ?? "").trim().toLowerCase() === stored.toLowerCase()) {
      return stored;
    }
  }
  const name = normalizedProfileName(field, value);
  if (await profileNameTaken(model, field, name, userId)) {
    throw new BadRequestException(
      field === "brandName" ? "Another brand already uses this name." : `That ${labelOf(field).toLowerCase()} is already taken.`,
    );
  }
  return name;
}
