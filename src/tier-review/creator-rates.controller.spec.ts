import { CreatorRatesController } from "./creator-rates.controller";

describe("CreatorRatesController (confirm rates without changing them)", () => {
  const ID = "64b0000000000000000000a1";
  const USER = "64b00000000000000000ffff";
  const setup = (matchedCount = 1) => {
    const calls: any[] = [];
    const connection = {
      collection: (name: string) => ({
        updateOne: (filter: any, update: any) => {
          calls.push([name, filter, update]);
          return Promise.resolve({ matchedCount });
        },
      }),
    };
    return { controller: new CreatorRatesController(connection as any), calls };
  };

  it("stamps every rate on the creator's own account", async () => {
    const { controller, calls } = setup();
    const res = await controller.confirm(
      { user: { role: "influencer", userId: USER } },
      { socialAccountId: ID },
    );
    expect(res.confirmedAt).toEqual(expect.any(Date));
    const [name, filter, update] = calls[0];
    expect(name).toBe("influencers");
    expect(String(filter._id)).toBe(USER);
    expect(filter["socialMedia.socialAccountId"]).toBe(ID);
    expect(Object.keys(update.$set)).toEqual([
      "socialMedia.$.contentTypes.$[].priceConfirmedAt",
    ]);
  });

  it("refuses brands, bad ids and someone else's account", async () => {
    await expect(
      setup().controller.confirm(
        { user: { role: "brand", userId: USER } },
        { socialAccountId: ID },
      ),
    ).rejects.toThrow("Only creators");
    await expect(
      setup().controller.confirm(
        { user: { role: "photographer", userId: USER } },
        { socialAccountId: "x" },
      ),
    ).rejects.toThrow("Invalid social account id");
    await expect(
      setup(0).controller.confirm(
        { user: { role: "photographer", userId: USER } },
        { socialAccountId: ID },
      ),
    ).rejects.toThrow("Social account not found");
  });
});
