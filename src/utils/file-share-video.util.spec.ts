import {
  campaignHasFileShare,
  isFileShareLink,
  isFileSharePlatform,
  normalizeShareEmail,
  sanitizeFileShareRow,
  socialPlatformsOnly,
} from "./file-share-video.util";

describe("Video (File Share) rules", () => {
  it("recognises the platform by name, key or stored post platform", () => {
    expect(isFileSharePlatform("Video (File Share)")).toBe(true);
    expect(isFileSharePlatform(" video (file share) ")).toBe(true);
    expect(isFileSharePlatform("file_share_video")).toBe(true);
    expect(isFileSharePlatform("file_share")).toBe(true);
    expect(isFileSharePlatform("YouTube")).toBe(false);
  });

  it("keeps it out of social-platform lists", () => {
    expect(socialPlatformsOnly(["Instagram", "Video (File Share)"])).toEqual(["Instagram"]);
    expect(campaignHasFileShare({ platforms: ["Instagram"] })).toBe(false);
    expect(campaignHasFileShare({ socialMedia: [{ platform: "Video (File Share)" }] })).toBe(true);
  });

  it("accepts file-sharing links only", () => {
    expect(isFileShareLink("https://drive.google.com/drive/folders/abc")).toBe(true);
    expect(isFileShareLink("https://www.dropbox.com/s/abc/v.mp4")).toBe(true);
    expect(isFileShareLink("https://we.tl/t-abc")).toBe(true);
    expect(isFileShareLink("https://1drv.ms/v/abc")).toBe(true);
    expect(isFileShareLink("https://instagram.com/reel/abc")).toBe(false);
    expect(isFileShareLink("https://drive.google.com.evil.example/abc")).toBe(false);
    expect(isFileShareLink("not a link")).toBe(false);
  });

  it("requires an aspect ratio on each enabled format and drops unknown formats", () => {
    const row = sanitizeFileShareRow({
      platform: "video (file share)",
      contentTypes: [
        { name: "raw video", enabled: true, price: 1000, aspectRatio: "9:16" },
        { name: "Edited video", enabled: false, price: 0, aspectRatio: "16:9" },
        { name: "Reel", enabled: true, price: 500 },
      ],
    });
    expect(row.platform).toBe("Video (File Share)");
    expect(row.contentTypes).toHaveLength(2);
    expect(row.contentTypes[0]).toMatchObject({ name: "Raw video", aspectRatio: "9:16" });
    expect(row.contentTypes[1].aspectRatio).toBeUndefined();

    expect(() =>
      sanitizeFileShareRow({
        contentTypes: [{ name: "Edited video", enabled: true, price: 1000 }],
      }),
    ).toThrow(/aspect ratio for Edited video/);
    expect(() =>
      sanitizeFileShareRow({
        contentTypes: [{ name: "Raw video", enabled: true, aspectRatio: "4:3" }],
      }),
    ).toThrow(/aspect ratio/);
  });

  it("normalizes share emails", () => {
    expect(normalizeShareEmail(" Team@Brand.IN ")).toBe("team@brand.in");
    expect(normalizeShareEmail("not-an-email")).toBe("");
  });
});
