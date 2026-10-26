import { GUARDS_METADATA } from "@nestjs/common/constants";
import { UsersController } from "./users.controller";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";

/**
 * Endpoints that read req.user must carry the login guard, or req.user is empty and
 * they refuse everyone (2026-10-26: inserting the data-export route split the guard
 * from getProfileVisibility and every login got "You can only view your own settings").
 */
describe("UsersController — signed-in endpoints keep their login guard", () => {
  const guarded = (method: keyof UsersController) =>
    (Reflect.getMetadata(GUARDS_METADATA, UsersController.prototype[method] as any) || []) as unknown[];

  for (const method of ["getProfileVisibility", "updateProfileVisibility", "exportMyData"] as const) {
    it(`${method} is guarded`, () => {
      expect(guarded(method)).toContain(JwtAuthGuard);
    });
  }
});
