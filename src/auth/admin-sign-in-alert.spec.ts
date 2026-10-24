jest.mock("../utils/security-alert.util", () => ({ sendSecurityAlert: jest.fn() }));
import { sendSecurityAlert } from "../utils/security-alert.util";
import { AuthService } from "./auth.service";

describe("admin sign-in alert", () => {
  const inserted: any[] = [];
  const log = { createIndex: jest.fn().mockResolvedValue(undefined), insertOne: jest.fn(async (d: any) => inserted.push(d)) };
  const service = (role: string) => {
    const s: any = Object.create(AuthService.prototype);
    s.userModel = { db: { collection: (name: string) => (name === "admin_sign_ins" ? log : null) } };
    s.loginChecked = jest.fn().mockResolvedValue({ userType: role, user: { id: "a1", email: "admin@x.in", name: "Admin", role } });
    return s;
  };
  beforeEach(() => { (sendSecurityAlert as jest.Mock).mockClear(); inserted.length = 0; });

  it("emails the admin and logs the sign-in with IP and browser", async () => {
    await service("admin").login("admin@x.in", "pw", undefined, { clientIp: "1.2.3.4", userAgent: "Chrome" });
    await new Promise((r) => setImmediate(r));
    expect(sendSecurityAlert).toHaveBeenCalledWith("admin@x.in", expect.stringContaining("1.2.3.4"), "Admin");
    expect(inserted[0]).toMatchObject({ adminId: "a1", ip: "1.2.3.4", userAgent: "Chrome" });
  });

  it("doesn't alert for a normal user's sign-in", async () => {
    await service("influencer").login("a@x.in", "pw");
    await new Promise((r) => setImmediate(r));
    expect(sendSecurityAlert).not.toHaveBeenCalled();
  });
});
