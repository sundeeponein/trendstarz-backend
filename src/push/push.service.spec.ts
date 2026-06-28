import { Test, TestingModule } from "@nestjs/testing";
import { getModelToken } from "@nestjs/mongoose";
import * as webpush from "web-push";
import { PushService } from "./push.service";

jest.mock("web-push", () => ({
  setVapidDetails: jest.fn(),
  sendNotification: jest.fn(),
}));

describe("PushService", () => {
  let service: PushService;
  let subModel: any;
  let preferenceModel: any;

  const mockSub = {
    _id: "507f1f77bcf86cd799439011",
    userId: "user-1",
    deviceType: "web",
    endpoint: "https://push.example.com/abc",
    keys: { p256dh: "p256dh-key", auth: "auth-key" },
  };

  beforeEach(async () => {
    process.env.VAPID_PUBLIC_KEY = "test-public-key";
    process.env.VAPID_PRIVATE_KEY = "test-private-key";

    subModel = {
      find: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([mockSub]) }),
      findOneAndUpdate: jest.fn(),
      deleteOne: jest.fn(),
    };

    preferenceModel = {
      findOne: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(null) }),
      findOneAndUpdate: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PushService,
        { provide: getModelToken("PushSubscription"), useValue: subModel },
        { provide: getModelToken("NotificationPreference"), useValue: preferenceModel },
      ],
    }).compile();

    service = module.get<PushService>(PushService);
    (webpush.sendNotification as jest.Mock).mockReset().mockResolvedValue(undefined);
  });

  it("wraps the payload under a top-level notification key so Angular's service worker will display it", async () => {
    await service.sendToUser("user-1", {
      title: "Payment verified",
      body: "You can now start posting for your campaign.",
      url: "/influencer-dashboard",
    }, "payment");

    expect(webpush.sendNotification).toHaveBeenCalledTimes(1);
    const [, rawPayload] = (webpush.sendNotification as jest.Mock).mock.calls[0];
    const parsed = JSON.parse(rawPayload);

    expect(parsed.notification).toBeDefined();
    expect(parsed.notification.title).toBe("Payment verified");
    expect(parsed.notification.body).toBe(
      "You can now start posting for your campaign.",
    );
  });

  it("puts the click-through URL under notification.data.onActionClick.default.url", async () => {
    await service.sendToUser("user-1", {
      title: "Post Submitted",
      body: "An influencer submitted content for your review.",
      url: "/admin/campaigns/123",
    }, "campaign");

    const [, rawPayload] = (webpush.sendNotification as jest.Mock).mock.calls[0];
    const parsed = JSON.parse(rawPayload);

    expect(parsed.notification.data.onActionClick.default.url).toBe(
      "/admin/campaigns/123",
    );
  });

  it("omits data when no url is provided", async () => {
    await service.sendToUser("user-1", {
      title: "No link",
      body: "Just an FYI",
    }, "campaign");

    const [, rawPayload] = (webpush.sendNotification as jest.Mock).mock.calls[0];
    const parsed = JSON.parse(rawPayload);

    expect(parsed.notification.data).toBeUndefined();
  });

  it("cleans up the subscription when the push service reports it is gone (410)", async () => {
    (webpush.sendNotification as jest.Mock).mockRejectedValue({ statusCode: 410 });

    const result = await service.sendToUser("user-1", {
      title: "Stale",
      body: "Should clean up",
    }, "campaign");

    expect(subModel.deleteOne).toHaveBeenCalledWith({ _id: mockSub._id });
    expect(result).toEqual({ sent: 0, failed: 1 });
  });

  it("defaults preferences to enabled when the user has never set any", async () => {
    const prefs = await service.getPreferences("user-1");
    expect(prefs).toEqual({
      webEnabled: true,
      mobileEnabled: true,
      campaignEnabled: true,
      paymentEnabled: true,
    });
  });

  it("skips sending to web subscriptions when webEnabled is false", async () => {
    preferenceModel.findOne.mockReturnValue({
      lean: jest.fn().mockResolvedValue({ webEnabled: false, mobileEnabled: true }),
    });

    const result = await service.sendToUser("user-1", {
      title: "Should not deliver",
      body: "web disabled",
    }, "campaign");

    expect(webpush.sendNotification).not.toHaveBeenCalled();
    expect(result).toEqual({ sent: 0, failed: 0 });
  });

  it("only sends to mobile subscriptions when webEnabled is false but mobileEnabled is true", async () => {
    subModel.find.mockReturnValue({
      lean: jest.fn().mockResolvedValue([
        mockSub,
        { ...mockSub, _id: "mobile-sub-id", deviceType: "mobile", endpoint: "https://push.example.com/mobile" },
      ]),
    });
    preferenceModel.findOne.mockReturnValue({
      lean: jest.fn().mockResolvedValue({ webEnabled: false, mobileEnabled: true }),
    });

    await service.sendToUser("user-1", { title: "Mobile only", body: "test" }, "campaign");

    expect(webpush.sendNotification).toHaveBeenCalledTimes(1);
    const [endpointArg] = (webpush.sendNotification as jest.Mock).mock.calls[0];
    expect(endpointArg.endpoint).toBe("https://push.example.com/mobile");
  });

  it("skips sending entirely when the event category is disabled, regardless of device preference", async () => {
    preferenceModel.findOne.mockReturnValue({
      lean: jest.fn().mockResolvedValue({ campaignEnabled: false, paymentEnabled: true }),
    });

    const result = await service.sendToUser("user-1", {
      title: "Campaign update",
      body: "should not deliver",
    }, "campaign");

    expect(webpush.sendNotification).not.toHaveBeenCalled();
    expect(result).toEqual({ sent: 0, failed: 0 });
  });

  it("still sends payment-category pushes when campaignEnabled is false but paymentEnabled is true", async () => {
    preferenceModel.findOne.mockReturnValue({
      lean: jest.fn().mockResolvedValue({ campaignEnabled: false, paymentEnabled: true }),
    });

    await service.sendToUser("user-1", { title: "Payment update", body: "test" }, "payment");

    expect(webpush.sendNotification).toHaveBeenCalledTimes(1);
  });

  it("setPreferences upserts only the provided fields", async () => {
    preferenceModel.findOneAndUpdate.mockResolvedValue({
      webEnabled: false,
      mobileEnabled: true,
      campaignEnabled: true,
      paymentEnabled: true,
    });

    const result = await service.setPreferences("user-1", { webEnabled: false });

    expect(preferenceModel.findOneAndUpdate).toHaveBeenCalledWith(
      { userId: "user-1" },
      { $set: { webEnabled: false } },
      { upsert: true, new: true },
    );
    expect(result).toEqual({
      webEnabled: false,
      mobileEnabled: true,
      campaignEnabled: true,
      paymentEnabled: true,
    });
  });
});
