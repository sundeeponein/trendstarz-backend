jest.mock("axios", () => ({ post: jest.fn() }));
import axios from "axios";
import { RazorpayService } from "./razorpay.service";

describe("RazorpayX errors carry no credentials", () => {
  it("keeps the status and Razorpay's reason, drops the request and its auth header", async () => {
    (axios.post as jest.Mock).mockRejectedValueOnce(
      Object.assign(new Error("Request failed with status code 400"), {
        response: { status: 400, data: { error: { code: "BAD_REQUEST_ERROR", description: "Invalid VPA" } } },
        config: { headers: { Authorization: "Basic cnpwX2tleTpTRUNSRVQ=" } },
      }),
    );
    const service: any = Object.create(RazorpayService.prototype);
    service.getRazorpayXCredentials = () => ({ keyId: "rzp_key", keySecret: "SECRET", baseUrl: "https://api.razorpay.com/v1", accountNumber: "1" });
    const err: any = await service.razorpayXPost("/payouts", {}).catch((e: any) => e);
    expect(err.message).toMatch(/HTTP 400.*Invalid VPA/);
    expect(err.response.status).toBe(400); // the payout sweep's refused-vs-unclear rule still works
    expect(JSON.stringify(err) + err.message).not.toMatch(/Basic|SECRET|cnpw/);
  });
});
