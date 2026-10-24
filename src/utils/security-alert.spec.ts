jest.mock("./app-email.service", () => ({ sendAppEmail: jest.fn().mockResolvedValue(undefined) }));
import { sendAppEmail } from "./app-email.service";
import { maskEmail, sendSecurityAlert } from "./security-alert.util";

describe("security alert emails", () => {
  beforeEach(() => (sendAppEmail as jest.Mock).mockClear());

  it("tells the owner what changed, escaped, with a way to secure the account", () => {
    sendSecurityAlert("asha@x.in", `Your login email was changed to ${maskEmail("evil@bad.com")}.`, "<i>Asha</i>");
    const mail = (sendAppEmail as jest.Mock).mock.calls[0][0];
    expect(mail.to).toBe("asha@x.in");
    expect(mail.subject).toMatch(/Security alert/);
    expect(mail.html).toContain("ev***@bad.com");
    expect(mail.html).not.toContain("<i>Asha</i>");
    expect(mail.text).toMatch(/reset your password/);
  });

  it("never mails anonymized or missing addresses", () => {
    sendSecurityAlert("deleted-123@trendstarz.invalid", "x");
    sendSecurityAlert("", "x");
    expect(sendAppEmail).not.toHaveBeenCalled();
  });
});
