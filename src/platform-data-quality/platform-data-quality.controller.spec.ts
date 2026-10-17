import { ExecutionContext, ForbiddenException } from "@nestjs/common";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { RolesGuard } from "../auth/roles.guard";
import { PlatformDataQualityController } from "./platform-data-quality.controller";

const ctx = (role?: string) =>
  ({
    switchToHttp: () => ({
      getRequest: () => ({ user: role ? { role } : undefined }),
    }),
  }) as unknown as ExecutionContext;

describe("PlatformDataQualityController authorization", () => {
  it("is protected by JwtAuthGuard and RolesGuard", () => {
    const guards = Reflect.getMetadata(
      GUARDS_METADATA,
      PlatformDataQualityController,
    );
    expect(guards).toEqual([JwtAuthGuard, RolesGuard]);
  });

  it("lets admins through the role guard", () => {
    expect(new RolesGuard().canActivate(ctx("admin"))).toBe(true);
  });

  it.each(["influencer", "brand", "photographer", undefined])(
    "refuses %s",
    (role) => {
      expect(() => new RolesGuard().canActivate(ctx(role))).toThrow(
        ForbiddenException,
      );
    },
  );

  it("delegates to the read-only service", async () => {
    const service = {
      getReport: jest.fn().mockResolvedValue({ readOnly: true }),
    };
    const controller = new PlatformDataQualityController(service as any);
    await expect(controller.getDataQuality()).resolves.toEqual({
      readOnly: true,
    });
  });
});
