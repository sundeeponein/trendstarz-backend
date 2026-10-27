import { ALL_PROFESSIONAL_CREATORS, UsersService } from "./users.service";

/** Search ?creatorType=: matches what cards show — types only count for professional creators. */
describe("Search: creator type filter", () => {
  const filterFor = async (creatorType?: string) => {
    const s: any = Object.create(UsersService.prototype);
    const countDocuments = jest.fn(async () => 0);
    s.influencerModel = { aggregate: () => ({ exec: async () => [] }), countDocuments };
    s.resolveViewerLocationContext = async () => ({});
    s.plansService = { canViewSocialLinks: async () => false };
    s.publicProfileBlockedIds = async () => [];
    s.collaborationAuditSummaryMap = async () => new Map();
    await s.getInfluencers(1, 20, null, true, { creatorType });
    return (countDocuments.mock.calls[0] as any[])[0];
  };

  it("a type matches professional creators with that type, any case", async () => {
    const f = await filterFor("ugc creator");
    expect(f.professionalStatus).toBe(true);
    expect(f.creatorTypes.test("UGC Creator")).toBe(true);
    expect(f.creatorTypes.test("UGC Creator Pro")).toBe(false);
  });

  it("'all professional creators' matches every professional creator", async () => {
    const f = await filterFor(ALL_PROFESSIONAL_CREATORS);
    expect(f.professionalStatus).toBe(true);
    expect(f.creatorTypes).toBeUndefined();
  });

  it("no type: no professional filter", async () => {
    const f = await filterFor(undefined);
    expect(f.professionalStatus).toBeUndefined();
    expect(f.creatorTypes).toBeUndefined();
  });
});
