import { Controller, Get, Res } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import { Response } from "express";

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
  ) {}

  @Get("sitemap.xml")
  async getSitemap(@Res() res: Response) {
    const today = toDateStr(new Date());

    const [influencers, brands, photographers] = await Promise.all([
      this.influencerModel
        .find({ status: "accepted" })
        .select("username updatedAt")
        .lean(),
      this.brandModel
        .find({})
        .select("brandUsername brandName updatedAt")
        .lean(),
      this.photographerModel
        .find({ status: "accepted" })
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

    res.setHeader("Content-Type", "text/xml; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.send(xml);
  }
}
