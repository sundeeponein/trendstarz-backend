import { CampaignsService } from "./campaigns.service";
import {
  PRODUCT_TIMELINE_DEFAULTS,
  computeProductTimeline,
  postDateOnDelivery,
  productTimelineSettings,
  releaseAvailableAt,
} from "./product-timeline.util";

const ist = (ymd: string, hhmm = "12:00") => new Date(`${ymd}T${hhmm}:00+05:30`);
const utcDay = (ymd: string) => new Date(`${ymd}T00:00:00.000Z`);

describe("product timeline (2026-11-11)", () => {
  const s = PRODUCT_TIMELINE_DEFAULTS;

  it("start 11 Nov → accept by 13 Nov 23:59 IST, ship by 15 Nov 23:59 IST, post from 18 Nov, leave free from 18 Nov 00:00 IST", () => {
    const t = computeProductTimeline(utcDay("2026-11-11"), s);
    expect(t.acceptanceDeadline.getTime()).toBe(ist("2026-11-13", "23:59").getTime() + 59_999);
    expect(t.shipByDate.getTime()).toBe(ist("2026-11-15", "23:59").getTime() + 59_999);
    expect(t.earliestPostDate.toISOString()).toBe("2026-11-18T00:00:00.000Z");
    expect(releaseAvailableAt(t.shipByDate, s.releaseAfterShipByDays).getTime()).toBe(ist("2026-11-18", "00:00").getTime());
  });

  it("admin settings change the numbers", () => {
    const custom = productTimelineSettings({ productAcceptanceDays: 3, productShippingDays: 4, maxCampaignDurationDays: 20 });
    expect(custom).toMatchObject({ acceptDays: 3, shipByDays: 2, shippingDays: 4, postAfterDays: 7, capDays: 20 });
    expect(computeProductTimeline(utcDay("2026-11-11"), custom).earliestPostDate.toISOString()).toBe("2026-11-18T00:00:00.000Z");
  });

  it("delivery keeps the creator's date when it's still ahead; otherwise up to 7 days (cap), never shortening it", () => {
    const start = utcDay("2026-11-11");
    expect(postDateOnDelivery(ist("2026-11-17"), utcDay("2026-11-22"), start, s)).toEqual({ postDate: utcDay("2026-11-22"), adjusted: false });
    expect(postDateOnDelivery(ist("2026-11-20"), utcDay("2026-11-19"), start, s)).toEqual({ postDate: utcDay("2026-11-26"), adjusted: true });
    // Cap: start + 15 = 26 Nov.
    expect(postDateOnDelivery(ist("2026-11-23"), utcDay("2026-11-22"), start, s).postDate.toISOString()).toBe("2026-11-26T00:00:00.000Z");
    // Delivered the same day as the chosen date counts as late.
    expect(postDateOnDelivery(ist("2026-11-22"), utcDay("2026-11-22"), start, s).adjusted).toBe(true);
  });
});

describe("campaign create/update stamps the product timeline", () => {
  const service: any = Object.create(CampaignsService.prototype);
  const product = { campaignType: "product", productShippingRequired: true };

  it("new product campaigns that ship get it; too short ones are refused", () => {
    const n: any = { ...product, startDate: utcDay("2026-11-11"), endDate: utcDay("2026-11-25") };
    service.applyProductTimeline(n, null, {});
    expect(n.productTimeline).toBe(true);
    expect(n.earliestPostDate.toISOString()).toBe("2026-11-18T00:00:00.000Z");
    expect(() =>
      service.applyProductTimeline({ ...product, startDate: utcDay("2026-11-11"), endDate: utcDay("2026-11-16") }, null, {}),
    ).toThrow("at least 8 days");
  });

  it("drafts get it; approved campaigns from before keep their dates; non-shipping campaigns don't", () => {
    const draft: any = { startDate: utcDay("2026-11-11") };
    service.applyProductTimeline(draft, { ...product, status: "draft", endDate: utcDay("2026-11-25") }, {});
    expect(draft.productTimeline).toBe(true);

    const live: any = { title: "x" };
    service.applyProductTimeline(live, { ...product, status: "active", startDate: utcDay("2026-11-11"), endDate: utcDay("2026-11-25") }, {});
    expect(live.productTimeline).toBeUndefined();
    expect(live.acceptanceDeadline).toBeUndefined();

    const paid: any = { campaignType: "paid_collab", startDate: utcDay("2026-11-11"), endDate: utcDay("2026-11-25") };
    service.applyProductTimeline(paid, null, {});
    expect(paid.productTimeline).toBeUndefined();
  });
});
