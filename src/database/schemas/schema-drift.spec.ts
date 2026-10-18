import * as fs from "fs";
import * as path from "path";
import { Schema } from "mongoose";
import { CampaignInviteSchema } from "./campaign-invite.schema";
import {
  AppSettingsSchema,
  BrandSchema,
  CampaignSchema,
  InfluencerSchema,
  PhotographerSchema,
} from "./profile.schemas";
import { CampaignTransactionSchema } from "./campaign-transaction.schema";
import { CampaignSubmissionSchema } from "./campaign-submission.schema";
import { PaymentSchema } from "./payment.schema";

/**
 * Mongoose silently DROPS fields that aren't in the schema. That is how the
 * creator's shipping address and the invite's recipientRole were lost for
 * months (fixed 2026-10-18). This scans the code for `<doc>.<field> = …` on
 * these documents and fails if the field isn't declared.
 */
const DOCS: Array<[variable: string, schema: Schema]> = [
  ["invite", CampaignInviteSchema],
  ["campaign", CampaignSchema],
  ["tx", CampaignTransactionSchema],
  ["submission", CampaignSubmissionSchema],
  ["payment", PaymentSchema],
  ["influencer", InfluencerSchema],
  ["brand", BrandSchema],
  ["existingBrand", BrandSchema],
  ["photographer", PhotographerSchema],
  ["settings", AppSettingsSchema],
];

const sourceFiles = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(full);
    return e.name.endsWith(".ts") && !e.name.endsWith("spec.ts") ? [full] : [];
  });

describe("schema drift: every field the code assigns is stored", () => {
  const files = sourceFiles(path.join(__dirname, "../.."));
  for (const [variable, schema] of DOCS) {
    it(`${variable}.* assignments are declared in the schema`, () => {
      const declared = new Set([
        ...Object.keys(schema.paths).map((p) => p.split(".")[0]),
        "_id", "__v", "createdAt", "updatedAt", "$where", "$locals",
      ]);
      const missing: string[] = [];
      for (const f of files) {
        const src = fs.readFileSync(f, "utf8");
        for (const m of src.matchAll(new RegExp(`\\b${variable}\\.([a-zA-Z_]\\w*)\\s*=(?!=)`, "g"))) {
          if (!declared.has(m[1])) missing.push(`${m[1]} (${path.basename(f)})`);
        }
      }
      expect([...new Set(missing)]).toEqual([]);
    });
  }
});
