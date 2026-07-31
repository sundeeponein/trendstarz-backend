import * as fs from "fs";
import * as path from "path";
import { Model } from "mongoose";

type ConfigDistrict = string | {
  name?: string;
  visible?: boolean;
  showInFrontend?: boolean;
};

type ConfigLocation = {
  state?: string;
  name?: string;
  visible?: boolean;
  showInFrontend?: boolean;
  districts?: ConfigDistrict[];
};

function readConfigLocations(): ConfigLocation[] {
  const possiblePaths = [
    path.join(__dirname, "../../assets/locations.json"),
    path.join(process.cwd(), "assets/locations.json"),
    path.join(__dirname, "../../assets/admin-config.json"),
    path.join(process.cwd(), "assets/admin-config.json"),
  ];

  for (const configPath of possiblePaths) {
    if (!fs.existsSync(configPath)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      if (Array.isArray(parsed)) return parsed;
      return Array.isArray(parsed?.locations) ? parsed.locations : [];
    } catch {
      return [];
    }
  }

  return [];
}

function configVisible(item: { visible?: boolean; showInFrontend?: boolean }): boolean {
  if (typeof item.showInFrontend === "boolean") return item.showInFrontend;
  if (typeof item.visible === "boolean") return item.visible;
  return true;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function seedMissingLocationsFromConfig(
  stateModel: Model<any>,
  districtModel: Model<any>,
): Promise<{ statesCreated: number; districtsCreated: number }> {
  const locations = readConfigLocations();
  let statesCreated = 0;
  let districtsCreated = 0;

  for (const loc of locations) {
    const stateName = String(loc.state || loc.name || "").trim();
    if (!stateName) continue;

    const stateDoc = await stateModel.findOne({
      name: new RegExp(`^${escapeRegex(stateName)}$`, "i"),
    }).lean();

    if (!stateDoc) {
      await stateModel.create({
        name: stateName,
        showInFrontend: configVisible(loc),
      });
      statesCreated += 1;
    }

    for (const rawDistrict of Array.isArray(loc.districts) ? loc.districts : []) {
      const district =
        typeof rawDistrict === "string" ? { name: rawDistrict } : rawDistrict;
      const districtName = String(district?.name || "").trim();
      if (!districtName) continue;

      const districtDoc = await districtModel.findOne({
        name: new RegExp(`^${escapeRegex(districtName)}$`, "i"),
        state: new RegExp(`^${escapeRegex(stateName)}$`, "i"),
      }).lean();

      if (districtDoc) continue;

      await districtModel.create({
        name: districtName,
        state: stateName,
        showInFrontend: configVisible(district),
      });
      districtsCreated += 1;
    }
  }

  return { statesCreated, districtsCreated };
}
