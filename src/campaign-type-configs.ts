import * as fs from "fs";
import * as path from "path";

export type CampaignTypeOwnerType = "brand" | "photographer";
export type CampaignAccessMode = "invite_only" | "tier_filtered_open";

export type CampaignTypeConfigItem = {
  key: string;
  label: string;
  ownerType: CampaignTypeOwnerType;
  enabled: boolean;
  premiumOnly: boolean;
  sortOrder: number;
};

export type CampaignAccessModeConfigItem = {
  key: CampaignAccessMode;
  label: string;
  enabled: boolean;
  premiumOnly: boolean;
  sortOrder: number;
};

export const CAMPAIGN_TYPE_ALLOWED_KEYS: Record<
  CampaignTypeOwnerType,
  Set<string>
> = {
  brand: new Set(["paid_collab", "product", "invite_location"]),
  photographer: new Set([
    "paid_collab",
    "product",
    "invite_location",
    "portfolio_collab",
    "reel_collab",
    "creative_project",
  ]),
};

function getAdminConfigPath(): string {
  let configPath = path.join(__dirname, "../assets/admin-config.json");
  if (!fs.existsSync(configPath)) {
    configPath = path.join(process.cwd(), "assets/admin-config.json");
  }
  return configPath;
}

function normalizeCampaignAccessMode(value: unknown): CampaignAccessMode {
  return String(value || "") === "tier_filtered_open"
    ? "tier_filtered_open"
    : "invite_only";
}

export function normalizeCampaignAccessModeConfigs(
  list: unknown,
  fallbackList?: unknown,
): CampaignAccessModeConfigItem[] {
  const defaults: CampaignAccessModeConfigItem[] = [
    {
      key: "invite_only",
      label: "Invite only",
      enabled: true,
      premiumOnly: false,
      sortOrder: 10,
    },
    {
      key: "tier_filtered_open",
      label: "Open to all",
      enabled: true,
      premiumOnly: false,
      sortOrder: 20,
    },
  ];
  const fallback =
    Array.isArray(fallbackList) && fallbackList.length
      ? fallbackList
      : defaults;
  const source = Array.isArray(list) && list.length ? list : fallback;
  const out: CampaignAccessModeConfigItem[] = [];
  const seen = new Set<string>();

  for (const raw of source) {
    if (!raw || typeof raw !== "object") continue;
    const key = normalizeCampaignAccessMode(raw.key || raw.value);
    if (seen.has(key)) continue;
    seen.add(key);
    const fallbackItem = fallback.find(
      (item: any) =>
        normalizeCampaignAccessMode(item?.key || item?.value) === key,
    );

    out.push({
      key,
      label: String(raw.label || fallbackItem?.label || key).trim(),
      enabled: raw.enabled !== false,
      premiumOnly: raw.premiumOnly === true,
      sortOrder: Number.isFinite(Number(raw.sortOrder))
        ? Number(raw.sortOrder)
        : Number(fallbackItem?.sortOrder || out.length * 10 + 10),
    });
  }

  for (const fallbackItem of fallback) {
    const key = normalizeCampaignAccessMode(
      fallbackItem?.key || fallbackItem?.value,
    );
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      key,
      label: String(fallbackItem?.label || key).trim(),
      enabled: fallbackItem?.enabled !== false,
      premiumOnly: fallbackItem?.premiumOnly === true,
      sortOrder: Number.isFinite(Number(fallbackItem?.sortOrder))
        ? Number(fallbackItem.sortOrder)
        : out.length * 10 + 10,
    });
  }

  return out.sort(
    (a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label),
  );
}

export function readAdminConfig(): any {
  const configPath = getAdminConfigPath();
  if (!fs.existsSync(configPath)) {
    return {};
  }
  const raw = fs.readFileSync(configPath, "utf-8");
  return JSON.parse(raw || "{}");
}

export function normalizeCampaignTypeConfigs(
  list: unknown,
  fallbackList?: unknown,
): CampaignTypeConfigItem[] {
  const fallback = Array.isArray(fallbackList) ? fallbackList : [];
  const source = Array.isArray(list) && list.length ? list : fallback;
  const out: CampaignTypeConfigItem[] = [];
  const seen = new Set<string>();

  for (const raw of source) {
    if (!raw || typeof raw !== "object") continue;
    const ownerType: CampaignTypeOwnerType =
      String(raw.ownerType || "brand") === "photographer"
        ? "photographer"
        : "brand";
    const key = String(raw.key || "").trim();
    if (!key || !CAMPAIGN_TYPE_ALLOWED_KEYS[ownerType].has(key)) continue;

    const dedupeKey = `${ownerType}:${key}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    out.push({
      key,
      ownerType,
      label: String(raw.label || key).trim(),
      enabled: raw.enabled !== false,
      premiumOnly: raw.premiumOnly === true,
      sortOrder: Number.isFinite(Number(raw.sortOrder))
        ? Number(raw.sortOrder)
        : out.length * 10 + 10,
    });
  }

  for (const raw of fallback) {
    if (!raw || typeof raw !== "object") continue;
    const ownerType: CampaignTypeOwnerType =
      String(raw.ownerType || "brand") === "photographer"
        ? "photographer"
        : "brand";
    const key = String(raw.key || "").trim();
    if (!key || !CAMPAIGN_TYPE_ALLOWED_KEYS[ownerType].has(key)) continue;

    const dedupeKey = `${ownerType}:${key}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    out.push({
      key,
      ownerType,
      label: String(raw.label || key).trim(),
      enabled: raw.enabled !== false,
      premiumOnly: raw.premiumOnly === true,
      sortOrder: Number.isFinite(Number(raw.sortOrder))
        ? Number(raw.sortOrder)
        : out.length * 10 + 10,
    });
  }

  return out.sort(
    (a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label),
  );
}

export function getCampaignTypeConfigDefaults(): CampaignTypeConfigItem[] {
  const config = readAdminConfig();
  return normalizeCampaignTypeConfigs(config?.campaignTypeConfigs, []);
}

export function resolveCampaignTypeConfigs(
  overrides: unknown,
): CampaignTypeConfigItem[] {
  const defaults = getCampaignTypeConfigDefaults();
  return normalizeCampaignTypeConfigs(overrides, defaults);
}

export function getCampaignAccessModeConfigDefaults(): CampaignAccessModeConfigItem[] {
  return normalizeCampaignAccessModeConfigs(undefined, undefined);
}

export function resolveCampaignAccessModeConfigs(
  overrides: unknown,
): CampaignAccessModeConfigItem[] {
  const defaults = getCampaignAccessModeConfigDefaults();
  return normalizeCampaignAccessModeConfigs(overrides, defaults);
}
