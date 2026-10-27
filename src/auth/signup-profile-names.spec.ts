import { AuthService } from "./auth.service";

/**
 * Sign-up uses the same profile-name rule as every profile save
 * (utils/profile-names.util.ts) for every role. These stop at the name checks,
 * before anything is created.
 */
describe("sign-up: one profile-name rule for every role", () => {
  // Stand-in models: findOne finds nothing; exists() answers from `stored`.
  const model = (stored: any[]) => ({
    findOne: () => null,
    exists: async (q: any) => {
      const conds = q.$or || [Object.fromEntries(Object.entries(q).filter(([k]) => k !== "_id"))];
      return stored.some((doc) =>
        conds.some((c: any) => Object.entries(c).every(([k, re]: any) => re instanceof RegExp && re.test(String(doc[k] ?? "")))),
      );
    },
  });
  const make = () => {
    const s: any = Object.create(AuthService.prototype);
    s.brandModel = model([{ brandName: "Vaarahi fashions", brandUsername: "carols-cosmetics" }]);
    s.influencerModel = model([{ username: "asha" }]);
    s.photographerModel = model([]);
    s.userModel = model([]);
    return s as AuthService;
  };
  const base = { acceptedTerms: true, password: "Strong#Pass1", email: "new@x.in" };
  const outcome = (p: Promise<unknown>) =>
    p.then(
      () => "created",
      (e) => e?.response?.duplicateFields?.join(",") || e.message,
    );

  it("brand: another brand's name in any spelling, or as a link name, is taken", async () => {
    for (const brandName of ["Vaarahi fashions", "VAARAHI  FASHIONS", "vaarahi-fashions", "Carols Cosmetics"]) {
      expect(await outcome(make().registerBrand({ ...base, brandName }))).toBe("brandName");
    }
    expect(await outcome(make().registerBrand({ ...base, brandName: "New Shop", brandUsername: "Vaarahi-Fashions" }))).toBe("brandUsername");
    expect(await outcome(make().registerBrand({ ...base, brandName: "New Shop", brandUsername: "new shop!" }))).toMatch(/Brand username can contain only/);
    expect(await outcome(make().registerBrand({ ...base, brandName: "   " }))).toBe("Brand name is required.");
  });

  it("influencer: usernames are checked for form and taken in any case", async () => {
    expect(await outcome(make().registerInfluencer({ ...base, username: "ASHA" }))).toBe("username");
    expect(await outcome(make().registerInfluencer({ ...base, username: "asha rao" }))).toMatch(/Username can contain only/);
    expect(await outcome(make().registerInfluencer({ ...base, username: "deleted-1" }))).toMatch(/Username can contain only/);
  });

  it("photographer: the same form rule", async () => {
    expect(await outcome(make().registerPhotographer({ ...base, username: "a/b" }))).toMatch(/Username can contain only/);
    expect(await outcome(make().registerPhotographer({ ...base, username: "" }))).toMatch(/Username can contain only/);
  });
});
