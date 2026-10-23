import { UsersController } from "./users.controller";
import { UsersService } from "./users.service";

describe("legacy POST /users/register", () => {
  it("is gone: it stored the request body as-is and read server files named as photos", () => {
    expect((UsersController.prototype as any).registerUser).toBeUndefined();
    expect((UsersService.prototype as any).registerInfluencer).toBeUndefined();
    expect((UsersService.prototype as any).registerBrand).toBeUndefined();
  });
});
