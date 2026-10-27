import { Controller, Get, NotFoundException, Param, Res } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Types } from "mongoose";
import { Response } from "express";
import { applyDiscoverableProfileFilter } from "./utils/profile-eligibility.util";
import { publicProfileBlockFlagCodes } from "./users/users.service";

const BASE_URL = "https://trendstarz.in";

function toSlug(value: string): string {
  return (value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** A Cloudinary photo resized for link previews (WhatsApp skips large images). */
export function previewImageUrl(url: unknown): string {
  const value = String(url || "");
  return value.replace(
    /^(https:\/\/res\.cloudinary\.com\/[^/]+\/image\/upload\/)(?=v\d+\/)/,
    "$1c_fill,w_600,h_600,q_auto,f_jpg/",
  );
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toDateStr(date: any): string {
  try {
    return new Date(date).toISOString().split("T")[0];
  } catch {
    return new Date().toISOString().split("T")[0];
  }
}

@Controller()
export class SitemapController {
  constructor(
    @InjectModel("Influencer") private influencerModel: Model<any>,
    @InjectModel("Brand") private brandModel: Model<any>,
    @InjectModel("Photographer") private photographerModel: Model<any>,
    @InjectModel("ProfileFlag") private profileFlagModel: Model<any>,
  ) {}

  /**
   * Only profiles a logged-out visitor could find in Search: approved, active,
   * Public (not Private or Members-only), not deleted, and with no open flag
   * that hides them. The sitemap asks Google to index these pages.
   */
  async publicProfileFilter(
    userType: "Influencer" | "Brand" | "Photographer",
  ): Promise<Record<string, any>> {
    const filter = applyDiscoverableProfileFilter(
      {},
      {
        photoField: userType === "Brand" ? "brandLogo" : "profileImages",
        requireSocialTier: userType !== "Brand",
        viewerIsAuthenticated: false,
      },
    );
    const blocked = await this.profileFlagModel.distinct("userId", {
      userType,
      status: "Open",
      flagCode: { $in: publicProfileBlockFlagCodes(userType) },
    });
    const blockedIds = blocked
      .map(String)
      .filter((id) => Types.ObjectId.isValid(id))
      .map((id) => new Types.ObjectId(id));
    if (blockedIds.length) filter._id = { $nin: blockedIds };
    return filter;
  }

  @Get("sitemap.xml")
  async getSitemap(@Res() res: Response) {
    const today = toDateStr(new Date());

    const [influencerFilter, brandFilter, photographerFilter] = await Promise.all([
      this.publicProfileFilter("Influencer"),
      this.publicProfileFilter("Brand"),
      this.publicProfileFilter("Photographer"),
    ]);
    const [influencers, brands, photographers] = await Promise.all([
      this.influencerModel
        .find(influencerFilter)
        .select("username updatedAt")
        .lean(),
      this.brandModel
        .find(brandFilter)
        .select("brandUsername brandName updatedAt")
        .lean(),
      this.photographerModel
        .find(photographerFilter)
        .select("username updatedAt")
        .lean(),
    ]);

    const staticUrls = [
      { loc: `${BASE_URL}/`, priority: "1.0", changefreq: "daily", lastmod: today },
      { loc: `${BASE_URL}/search`, priority: "0.9", changefreq: "daily", lastmod: today },
      { loc: `${BASE_URL}/how-it-works`, priority: "0.8", changefreq: "monthly", lastmod: today },
      { loc: `${BASE_URL}/how-it-works/influencers`, priority: "0.8", changefreq: "monthly", lastmod: today },
      { loc: `${BASE_URL}/how-it-works/brands`, priority: "0.8", changefreq: "monthly", lastmod: today },
      { loc: `${BASE_URL}/how-it-works/photographers`, priority: "0.8", changefreq: "monthly", lastmod: today },
      { loc: `${BASE_URL}/features`, priority: "0.8", changefreq: "monthly", lastmod: today },
      { loc: `${BASE_URL}/features/photographers`, priority: "0.8", changefreq: "monthly", lastmod: today },
      { loc: `${BASE_URL}/register-influencer`, priority: "0.7", changefreq: "monthly", lastmod: today },
      { loc: `${BASE_URL}/register-brand`, priority: "0.7", changefreq: "monthly", lastmod: today },
      { loc: `${BASE_URL}/register-photographer`, priority: "0.7", changefreq: "monthly", lastmod: today },
      { loc: `${BASE_URL}/contact`, priority: "0.5", changefreq: "monthly", lastmod: today },
      { loc: `${BASE_URL}/privacy-policy`, priority: "0.4", changefreq: "yearly", lastmod: today },
      { loc: `${BASE_URL}/terms-and-conditions`, priority: "0.4", changefreq: "yearly", lastmod: today },
      { loc: `${BASE_URL}/refund-policy`, priority: "0.4", changefreq: "yearly", lastmod: today },
    ];

    const influencerUrls = (influencers as any[])
      .filter((inf) => inf.username)
      .map((inf) => ({
        loc: `${BASE_URL}/influencer/${escapeXml(String(inf.username))}`,
        lastmod: toDateStr(inf.updatedAt),
        priority: "0.8",
        changefreq: "weekly",
      }));

    const brandUrls = (brands as any[])
      .filter((b) => b.brandUsername || b.brandName)
      .map((b) => {
        const slug = b.brandUsername || toSlug(b.brandName);
        return {
          loc: `${BASE_URL}/brand/${escapeXml(slug)}`,
          lastmod: toDateStr(b.updatedAt),
          priority: "0.8",
          changefreq: "weekly",
        };
      });

    const photographerUrls = (photographers as any[])
      .filter((p) => p.username)
      .map((p) => ({
        loc: `${BASE_URL}/photographer/${escapeXml(String(p.username))}`,
        lastmod: toDateStr(p.updatedAt),
        priority: "0.8",
        changefreq: "weekly",
      }));

    const allUrls = [...staticUrls, ...influencerUrls, ...brandUrls, ...photographerUrls];

    const urlEntries = allUrls
      .map(
        (u) =>
          `  <url>\n    <loc>${u.loc}</loc>\n    <lastmod>${u.lastmod}</lastmod>\n    <changefreq>${u.changefreq}</changefreq>\n    <priority>${u.priority}</priority>\n  </url>`,
      )
      .join("\n");

    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urlEntries}\n</urlset>`;

    res.type("application/xml; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=3600, must-revalidate");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.send(xml);
  }

  /**
   * Title, description and photo for link previews (WhatsApp, Facebook, X,
   * LinkedIn…), read by the website's middleware when a preview bot opens a
   * profile link. Same rule as the sitemap: profiles a logged-out visitor
   * could not find answer 404, and the bot gets the generic site preview.
   */
  @Throttle({ default: { ttl: 60000, limit: 60 } })
  @Get("share-preview/:kind/:slug")
  async getSharePreview(@Param("kind") kind: string, @Param("slug") slug: string) {
    const value = String(slug || "").trim().slice(0, 100);
    const place = (p: any) =>
      [p?.location?.district, p?.location?.state].map((x) => String(x || "").trim()).filter(Boolean).join(", ");
    const topics = (p: any) =>
      (Array.isArray(p?.categories) ? p.categories : []).map(String).filter(Boolean).slice(0, 3).join(" · ");

    if (value && (kind === "influencer" || kind === "photographer")) {
      const userType = kind === "influencer" ? "Influencer" : "Photographer";
      const model = kind === "influencer" ? this.influencerModel : this.photographerModel;
      const p: any = await model
        .findOne({ ...(await this.publicProfileFilter(userType)), username: value })
        .select("name username categories location profileImages")
        .lean();
      if (p) {
        const role = kind === "influencer" ? "Creator" : "Photographer / videographer";
        const where = place(p);
        return {
          title: `${p.name} — ${role} on TrendStarz`,
          description: [topics(p), where && `${role} in ${where}`, "View the profile and invite on TrendStarz."]
            .filter(Boolean)
            .join(". "),
          image: previewImageUrl(p.profileImages?.[0]?.url),
          url: `${BASE_URL}/${kind}/${encodeURIComponent(p.username)}`,
        };
      }
    }

    if (value && kind === "brand") {
      const filter = await this.publicProfileFilter("Brand");
      const select = "brandName brandUsername description categories location brandLogo";
      const b: any =
        (await this.brandModel
          .findOne({ ...filter, brandUsername: new RegExp(`^${escapeRegex(value)}$`, "i") })
          .select(select)
          .lean()) ||
        (await this.brandModel
          .findOne({ ...filter, brandName: new RegExp(`^${escapeRegex(value.replace(/-/g, " "))}$`, "i") })
          .select(select)
          .lean());
      if (b) {
        const about = String(b.description || "").replace(/\s+/g, " ").trim();
        return {
          title: `${b.brandName} on TrendStarz`,
          description:
            (about.length > 160 ? `${about.slice(0, 157)}…` : about) ||
            [topics(b), place(b) && `Brand in ${place(b)}`, "Collaborate with creators on TrendStarz."].filter(Boolean).join(". "),
          image: previewImageUrl(b.brandLogo?.[0]?.url),
          url: `${BASE_URL}/brand/${encodeURIComponent(b.brandUsername || toSlug(b.brandName))}`,
        };
      }
    }

    throw new NotFoundException("No public profile here");
  }
}
