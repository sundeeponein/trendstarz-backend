// eslint-disable-next-line @typescript-eslint/no-var-requires
const { plan } = require("../../cron/backupMedia.js");

describe("cron/backupMedia.js — where each file goes", () => {
  it("keeps the folder path, drops transformations and version, encrypts verification documents", () => {
    const photo = plan("https://res.cloudinary.com/ddnsoypf8/image/upload/c_fill,w_400/v1729000000/influencers/abc/profile/me.jpg");
    expect(photo).toMatchObject({ resourceType: "image", deliveryType: "upload", version: "1729000000", file: "influencers/abc/profile/me.jpg", isDocument: false });
    expect(photo.local.endsWith("backups/media/influencers/abc/profile/me.jpg")).toBe(true);

    const doc = plan("https://res.cloudinary.com/ddnsoypf8/image/authenticated/v1/influencer-verifications/pan.png");
    expect(doc).toMatchObject({ deliveryType: "authenticated", isDocument: true });
    expect(doc.local.endsWith("influencer-verifications/pan.png.enc")).toBe(true);

    expect(plan("https://example.com/not-cloudinary.png")).toBeNull();
  });
});
