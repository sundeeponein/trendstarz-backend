import * as fs from "fs";
import * as path from "path";

export type CampaignTypeOwnerType = "brand" | "photographer";

export type CampaignTypeConfigItem = {
  key: string;
  label: string;
  ownerType: CampaignTypeOwnerType;
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
      String((raw as any).ownerType || "brand") === "photographer"
        ? "photographer"
        : "brand";
    const key = String((raw as any).key || "").trim();
    if (!key || !CAMPAIGN_TYPE_ALLOWED_KEYS[ownerType].has(key)) continue;

    const dedupeKey = `${ownerType}:${key}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    out.push({
      key,
      ownerType,
      label: String((raw as any).label || key).trim(),
      enabled: (raw as any).enabled !== false,
      premiumOnly: (raw as any).premiumOnly === true,
      sortOrder: Number.isFinite(Number((raw as any).sortOrder))
        ? Number((raw as any).sortOrder)
        : out.length * 10 + 10,
    });
  }

  for (const raw of fallback) {
    if (!raw || typeof raw !== "object") continue;
    const ownerType: CampaignTypeOwnerType =
      String((raw as any).ownerType || "brand") === "photographer"
        ? "photographer"
        : "brand";
    const key = String((raw as any).key || "").trim();
    if (!key || !CAMPAIGN_TYPE_ALLOWED_KEYS[ownerType].has(key)) continue;

    const dedupeKey = `${ownerType}:${key}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    out.push({
      key,
      ownerType,
      label: String((raw as any).label || key).trim(),
      enabled: (raw as any).enabled !== false,
      premiumOnly: (raw as any).premiumOnly === true,
      sortOrder: Number.isFinite(Number((raw as any).sortOrder))
        ? Number((raw as any).sortOrder)
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
