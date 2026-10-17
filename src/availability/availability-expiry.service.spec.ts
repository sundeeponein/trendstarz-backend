import {
  AVAILABILITY_REMINDER,
  AvailabilityExpiryService,
  endedNotAvailable,
} from "./availability-expiry.service";

describe("availability expiry (Option B, 3D-1d)", () => {
  const NOW = new Date("2026-10-20T04:30:00.000Z");
  const DAY = 24 * 60 * 60 * 1000;
  const at = (d: number) => new Date(NOW.getTime() + d * DAY);

  it("selects only periods that have ended (legacy ones end 14 days after being set)", () => {
    const docs = [
      {
        _id: "ended",
        collaborationAvailability: { notAvailableUntil: at(-1) },
      },
      {
        _id: "running",
        collaborationAvailability: { notAvailableUntil: at(3) },
      },
      {
        _id: "legacy-old",
        collaborationAvailability: { stateUpdatedAt: at(-15) },
      },
      {
        _id: "legacy-new",
        collaborationAvailability: { stateUpdatedAt: at(-2) },
      },
      { _id: "no-dates", collaborationAvailability: {} },
    ];
    expect(endedNotAvailable(docs, NOW).map((d) => d._id)).toEqual([
      "ended",
      "legacy-old",
      "no-dates",
    ]);
  });

  const setup = (
    byCollection: Record<string, any[]>,
    modified: (id: string) => number = () => 1,
  ) => {
    const updates: Array<[string, any, any]> = [];
    const connection = {
      collection: (name: string) => ({
        find: () => ({
          toArray: () => Promise.resolve(byCollection[name] || []),
        }),
        updateOne: (filter: any, update: any) => {
          updates.push([name, filter, update]);
          return Promise.resolve({
            modifiedCount: modified(String(filter._id)),
          });
        },
      }),
    };
    const notifications = { createForUser: jasmine_fn() };
    const push = { sendToUser: jasmine_fn() };
    const service = new AvailabilityExpiryService(
      connection as any,
      notifications as any,
      push as any,
    );
    return { service, updates, notifications, push };
  };
  function jasmine_fn() {
    return jest.fn().mockResolvedValue(undefined);
  }

  it("resets an ended period to 'not set' (never to available) and reminds the creator once", async () => {
    const { service, updates, notifications, push } = setup({
      influencers: [
        {
          _id: "inf1",
          collaborationAvailability: { notAvailableUntil: at(-1) },
        },
        {
          _id: "inf2",
          collaborationAvailability: { notAvailableUntil: at(5) },
        },
      ],
      photographers: [
        {
          _id: "ph1",
          collaborationAvailability: { notAvailableUntil: at(-2) },
        },
      ],
    });
    await expect(service.resetEnded(NOW)).resolves.toBe(2);
    expect(updates.map(([c, f]) => `${c}:${f._id}`)).toEqual([
      "influencers:inf1",
      "photographers:ph1",
    ]);
    const [, filter, update] = updates[0];
    expect(filter["collaborationAvailability.state"]).toBe("not_available");
    expect(update.$set).toEqual({
      "collaborationAvailability.state": null,
      "collaborationAvailability.enabled": false,
      "collaborationAvailability.stateUpdatedAt": NOW,
      "collaborationAvailability.notAvailableUntil": null,
    });
    expect(notifications.createForUser).toHaveBeenCalledWith({
      userId: "inf1",
      userRole: "influencer",
      url: "/influencer-profile",
      ...AVAILABILITY_REMINDER,
    });
    expect(notifications.createForUser).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "ph1",
        userRole: "photographer",
        url: "/photographer-profile",
      }),
    );
    expect(push.sendToUser).toHaveBeenCalledTimes(2);
  });

  it("no reminder when the creator changed it in the meantime (guarded update modified nothing)", async () => {
    const { service, notifications } = setup(
      {
        influencers: [
          {
            _id: "inf1",
            collaborationAvailability: { notAvailableUntil: at(-1) },
          },
        ],
      },
      () => 0,
    );
    await expect(service.resetEnded(NOW)).resolves.toBe(0);
    expect(notifications.createForUser).not.toHaveBeenCalled();
  });
});
