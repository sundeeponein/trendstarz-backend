import { AdminListsController } from "../admin-lists.controller";

/** Admin → Settings save: GST needs a GST registration (GSTIN). */
describe("settings: GST requires a GSTIN", () => {
  const make = (saved: any) => {
    const c: any = Object.create(AdminListsController.prototype);
    const update: jest.Mock = jest.fn((..._args: any[]) => ({ lean: () => Promise.resolve({}) }));
    c.appSettingsModel = {
      findOne: () => ({ select: () => ({ lean: () => Promise.resolve(saved) }) }),
      findOneAndUpdate: update,
    };
    return { c, update };
  };

  it("refuses GST 18% while no GSTIN is saved", async () => {
    const { c, update } = make({ gstin: "" });
    await expect(c.updateSettings({ gstPercent: 18 })).rejects.toThrow(/GSTIN/);
    expect(update).not.toHaveBeenCalled();
  });

  it("refuses an invalid GSTIN, including a one-character typo", async () => {
    const { c } = make({});
    await expect(c.updateSettings({ gstin: "ABCDE1234F", gstPercent: 18 })).rejects.toThrow(/valid/);
    await expect(c.updateSettings({ gstin: "36ABCDE1234F1Z5", gstPercent: 18 })).rejects.toThrow(/typo/);
  });

  it("allows GST 18% with a valid GSTIN (saved now or before), and GST 0 always", async () => {
    let t = make({});
    await expect(c(t).updateSettings({ gstin: "36abcde1234f1z1", gstPercent: 18 })).resolves.toBeDefined();
    expect((t.update.mock.calls[0] as any)[1].$set.gstin).toBe("36ABCDE1234F1Z1");
    t = make({ gstin: "36ABCDE1234F1Z1" });
    await expect(c(t).updateSettings({ gstPercent: 18 })).resolves.toBeDefined();
    t = make({ gstin: "" });
    await expect(c(t).updateSettings({ gstPercent: 0 })).resolves.toBeDefined();
  });
  const c = (t: any) => t.c;
});
