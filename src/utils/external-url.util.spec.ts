import { normalizeExternalUrl } from "./external-url.util";

describe("normalizeExternalUrl", () => {
  it("adds https:// to bare domains so links don't open inside TrendStarZ", () => {
    expect(normalizeExternalUrl("vaarahifashions.in")).toBe("https://vaarahifashions.in");
    expect(normalizeExternalUrl(" www.instagram.com/rebuildwithsundeep ")).toBe("https://www.instagram.com/rebuildwithsundeep");
    expect(normalizeExternalUrl("http://shop.example.com/a?b=1")).toBe("http://shop.example.com/a?b=1");
    expect(normalizeExternalUrl("//maps.google.com/x")).toBe("https://maps.google.com/x");
  });

  it("never stores script or other non-web links", () => {
    for (const bad of ["javascript:alert(1)", "JAVASCRIPT:alert(1)", "data:text/html,<b>x</b>", "vbscript:x", "mailto:a@b.in", "just words", "https://"]) {
      expect(normalizeExternalUrl(bad)).toBe("");
    }
    expect(normalizeExternalUrl("")).toBe("");
  });
});
