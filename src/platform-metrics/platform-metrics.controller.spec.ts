import { BadRequestException } from "@nestjs/common";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { RolesGuard } from "../auth/roles.guard";
import { PlatformMetricsController } from "./platform-metrics.controller";

describe("PlatformMetricsController", () => {
  const service = {
    overview: jest.fn().mockResolvedValue({}),
    timeSeries: jest.fn().mockResolvedValue({}),
    creators: jest.fn().mockResolvedValue({}),
    owners: jest.fn().mockResolvedValue({}),
    campaigns: jest.fn().mockResolvedValue({}),
    relationships: jest.fn().mockResolvedValue({}),
    attributeCoverage: jest.fn().mockResolvedValue({}),
  };
  const controller = new PlatformMetricsController(service as any);
  beforeEach(() => jest.clearAllMocks());

  it("is admin-only (JwtAuthGuard + RolesGuard)", () => {
    expect(
      Reflect.getMetadata(GUARDS_METADATA, PlatformMetricsController),
    ).toEqual([JwtAuthGuard, RolesGuard]);
  });

  it("defaults to last30Days and a page of 50", async () => {
    await controller.creators();
    expect(service.creators).toHaveBeenCalledWith("last30Days", {
      role: undefined,
      limit: 50,
      offset: 0,
    });
  });

  it("passes validated filters through", async () => {
    await controller.owners("all", "photographer", "10", "20");
    expect(service.owners).toHaveBeenCalledWith("all", {
      ownerType: "photographer",
      limit: 10,
      offset: 20,
    });
    const id = "64b0000000000000000000aa";
    await controller.relationships(id, undefined, "5");
    expect(service.relationships).toHaveBeenCalledWith({
      creatorId: id,
      campaignId: undefined,
      limit: 5,
      offset: 0,
    });
  });

  it.each([
    ["an unknown window", () => controller.overview("lastYear")],
    ["limit 0", () => controller.campaigns("all", "0")],
    ["limit above 200", () => controller.campaigns("all", "201")],
    ["a negative offset", () => controller.campaigns("all", "10", "-1")],
    ["an unknown role", () => controller.creators("all", "brand")],
    ["an unknown owner type", () => controller.owners("all", "influencer")],
    ["a malformed id", () => controller.relationships("not-an-id")],
  ])("rejects %s", (_label, call) => {
    expect(call).toThrow(BadRequestException);
  });
});
