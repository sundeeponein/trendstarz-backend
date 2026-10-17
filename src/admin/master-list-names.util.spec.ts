import { nameHolders } from "./master-list-names.util";

const paths = (kind: any, role?: string) =>
  nameHolders(kind, role).map((h) => `${h.model}.${h.path}`);

describe("nameHolders", () => {
  it("keeps category renames inside the category's role", () => {
    expect(paths("category", "brand")).toEqual(["brand.categories"]);
    expect(paths("category", "photographer")).toEqual([
      "photographer.skills",
      "campaign.categories",
    ]);
    expect(paths("category", "influencer")).toEqual([
      "influencer.categories",
      "influencer.influencerCategory",
      "campaign.categories",
    ]);
  });

  it("treats both/unset category roles as every holder", () => {
    expect(paths("category", "both")).toEqual(paths("category"));
    expect(paths("category")).toHaveLength(5);
  });

  it("covers every place a state name is stored", () => {
    expect(paths("state")).toEqual(
      expect.arrayContaining([
        "influencer.location.state",
        "photographer.location.state",
        "campaign.targetState",
        "campaign.venueState",
        "district.state",
        "whatsappCommunity.state",
        "user.communityState",
      ]),
    );
  });
});
