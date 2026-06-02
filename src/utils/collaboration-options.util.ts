import * as fs from "fs";
import * as path from "path";

type Option = { name: string; visible: boolean };

const DEFAULT_CREATOR_TYPE_OPTIONS = [
  "UGC Creator",
  "Model",
  "Actor",
  "Host/Presenter",
  "Content Creator",
  "Lifestyle Creator",
  "Fashion Creator",
];

const DEFAULT_CONFIG = {
  influencer: {
    collaborationTypes: [
      "Photoshoots",
      "Video Shoots",
      "Travel Shoots",
      "Brand Campaign Shoots",
      "Portfolio Collaborations",
    ],
    preferences: ["Paid Only", "Paid + Selective TFP", "Open to TFP/Portfolio"],
    availableFor: ["Photo/Videographers", "Brands", "Agencies"],
    locations: ["Hyderabad", "Bangalore", "Chennai"],
  },
  photographer: {
    preferences: ["Paid Only", "Paid + Selective TFP", "Open to TFP/Portfolio"],
    availableFor: ["Influencers", "Brands", "Agencies"],
    locations: ["Hyderabad", "Bangalore", "Chennai"],
  },
};

function normalizeList(value: unknown, fallback: string[]): Option[] {
  const source = Array.isArray(value) && value.length ? value : fallback;
  return source
    .map((item: any) => {
      if (typeof item === "string") {
        const name = item.trim();
        return name ? { name, visible: true } : null;
      }
      const name = String(item?.name || "").trim();
      if (!name) return null;
      return { name, visible: item?.visible !== false };
    })
    .filter((item): item is Option => !!item);
}

function normalizePhotoVideographerOptions(items: Option[]): Option[] {
  const out: Option[] = [];
  let sawLegacyPhotoRole = false;
  let legacyPhotoRoleVisible = false;

  for (const item of items) {
    const key = item.name.trim().toLowerCase();
    if (
      key === "photographers" ||
      key === "videographers" ||
      key === "photo/videographers" ||
      key === "photo-videographers" ||
      key === "photographers/videographers"
    ) {
      sawLegacyPhotoRole = true;
      legacyPhotoRoleVisible = legacyPhotoRoleVisible || item.visible !== false;
      continue;
    }
    out.push(item);
  }

  if (sawLegacyPhotoRole) {
    out.unshift({ name: "Photo/Videographers", visible: legacyPhotoRoleVisible });
  }

  return out;
}

export function normalizeCreatorTypeConfig(raw: unknown): Option[] {
  return normalizeList(raw, DEFAULT_CREATOR_TYPE_OPTIONS);
}

export function visibleCreatorTypeConfig(raw: unknown): Option[] {
  return normalizeCreatorTypeConfig(raw).filter((item) => item.visible !== false);
}

export function normalizeCollaborationOptionConfig(raw: any) {
  const cfg = raw || {};
  return {
    influencer: {
      collaborationTypes: normalizeList(
        cfg?.influencer?.collaborationTypes,
        DEFAULT_CONFIG.influencer.collaborationTypes,
      ),
      preferences: normalizeList(
        cfg?.influencer?.preferences,
        DEFAULT_CONFIG.influencer.preferences,
      ),
      availableFor: normalizePhotoVideographerOptions(
        normalizeList(
          cfg?.influencer?.availableFor,
          DEFAULT_CONFIG.influencer.availableFor,
        ),
      ),
      locations: normalizeList(
        cfg?.influencer?.locations,
        DEFAULT_CONFIG.influencer.locations,
      ),
    },
    photographer: {
      preferences: normalizeList(
        cfg?.photographer?.preferences,
        DEFAULT_CONFIG.photographer.preferences,
      ),
      availableFor: normalizeList(
        cfg?.photographer?.availableFor,
        DEFAULT_CONFIG.photographer.availableFor,
      ),
      locations: normalizeList(
        cfg?.photographer?.locations,
        DEFAULT_CONFIG.photographer.locations,
      ),
    },
  };
}

export function visibleCollaborationOptionConfig(raw: any) {
  const normalized = normalizeCollaborationOptionConfig(raw);
  const visible = (items: Option[]) => items.filter((item) => item.visible !== false);
  return {
    influencer: {
      collaborationTypes: visible(normalized.influencer.collaborationTypes),
      preferences: visible(normalized.influencer.preferences),
      availableFor: visible(normalized.influencer.availableFor),
      locations: visible(normalized.influencer.locations),
    },
    photographer: {
      preferences: visible(normalized.photographer.preferences),
      availableFor: visible(normalized.photographer.availableFor),
      locations: visible(normalized.photographer.locations),
    },
  };
}

export function readAdminConfigFile(): any {
  const possiblePaths = [
    path.join(__dirname, "../../assets/admin-config.json"),
    path.join(process.cwd(), "assets/admin-config.json"),
  ];
  for (const configPath of possiblePaths) {
    if (!fs.existsSync(configPath)) continue;
    try {
      return JSON.parse(fs.readFileSync(configPath, "utf-8") || "{}");
    } catch {
      return {};
    }
  }
  return {};
}
