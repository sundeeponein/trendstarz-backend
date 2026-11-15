import { rangeTopFor, rateRangeTable, ratesForFollowers } from "./rate-suggestion.util";

describe("usual rate ranges per tier (2026-11-15)", () => {
  const table = rateRangeTable();

  it("Reel/Shorts ranges per tier; open-ended for Mega", () => {
    expect(table["Starter"].reel).toEqual({ min: 50, max: 150 });
    expect(table["Nano"].reel).toEqual({ min: 150, max: 500 });
    expect(table["Micro"].reel).toEqual({ min: 500, max: 3000 });
    expect(table["Mid-Tier"].reel).toEqual({ min: 3000, max: 10000 });
    expect(table["Macro"].reel).toEqual({ min: 10000, max: 40000 });
    expect(table["Mega / Celebrity"].reel).toEqual({ min: 40000, max: null });
  });

  it("Video ×1.8, Story ×0.4, never under ₹50", () => {
    expect(table["Starter"].video).toEqual({ min: 90, max: 270 });
    expect(table["Starter"].story).toEqual({ min: 50, max: 60 });
    expect(table["Nano"].story).toEqual({ min: 60, max: 200 });
    expect(table["Mega / Celebrity"].video).toEqual({ min: 72000, max: null });
  });

  it("range top by tier name and rate name", () => {
    expect(rangeTopFor("Starter (1–100)", "Reel")).toBe(150);
    expect(rangeTopFor("starter", "YouTube Shorts")).toBe(150);
    expect(rangeTopFor("Starter", "Video")).toBe(270);
    expect(rangeTopFor("Starter", "Photo post")).toBeNull(); // no range for this rate
    expect(rangeTopFor("Mega / Celebrity", "Reel")).toBeNull(); // open-ended
    expect(rangeTopFor("", "Reel")).toBeNull();
  });

  it("stored TrendScore audits keep one number: the bottom of the range", () => {
    expect(ratesForFollowers(27)).toEqual({ reelPrice: 50, videoPrice: 90, storyPrice: 50 });
    expect(ratesForFollowers(0)).toBeNull();
  });
});
