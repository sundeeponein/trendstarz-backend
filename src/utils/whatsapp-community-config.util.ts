import * as fs from "fs";
import * as path from "path";
import { Model } from "mongoose";

export type WhatsAppCommunityConfigItem = {
  state: string;
  stateKey: string;
  communityName: string;
  communityLink: string;
  isActive: boolean;
};

export function normalizeCommunityStateKey(state: unknown): string {
  return String(state || "")
    .trim()
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function getWhatsAppCommunityConfigPath(): string {
  const candidates = [
    path.join(__dirname, "../../assets/whatsapp-communities.json"),
    path.join(process.cwd(), "assets/whatsapp-communities.json"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[1];
}

export function readWhatsAppCommunityConfig(): WhatsAppCommunityConfigItem[] {
  const configPath = getWhatsAppCommunityConfigPath();
  if (!fs.existsSync(configPath)) return [];
  const raw = fs.readFileSync(configPath, "utf-8");
  const parsed = JSON.parse(raw || "{}");
  const source = Array.isArray(parsed?.communities)
    ? parsed.communities
    : Array.isArray(parsed)
      ? parsed
      : [];

  const seen = new Set<string>();
  return source
    .map((item: any) => {
      const state = String(item?.state || item?.name || "").trim();
      const stateKey = normalizeCommunityStateKey(item?.stateKey || state);
      const communityName = String(item?.communityName || item?.groupName || "").trim();
      const communityLink = String(item?.communityLink || item?.whatsappLink || "").trim();
      if (!stateKey || !state || !communityName || !communityLink) return null;
      if (seen.has(stateKey)) return null;
      seen.add(stateKey);
      return {
        state,
        stateKey,
        communityName,
        communityLink,
        isActive: item?.isActive !== false,
      };
    })
    .filter((item: WhatsAppCommunityConfigItem | null): item is WhatsAppCommunityConfigItem => !!item);
}

export async function seedMissingWhatsAppCommunitiesFromConfig(
  whatsappCommunityModel: Model<any>,
) {
  const defaults = readWhatsAppCommunityConfig();
  for (const item of defaults) {
    await whatsappCommunityModel.updateOne(
      { stateKey: item.stateKey },
      { $setOnInsert: item },
      { upsert: true },
    );
  }
}
