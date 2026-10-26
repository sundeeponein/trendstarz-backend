import { publicPageArgs, PUBLIC_LIST_MAX_LIMIT } from "./users.service";

describe("public directory lists can't be dumped in one request", () => {
  it("caps the page size and cleans bad input", () => {
    expect(publicPageArgs(1, 100000)).toEqual({ page: 1, limit: PUBLIC_LIST_MAX_LIMIT });
    expect(publicPageArgs(2, 120)).toEqual({ page: 2, limit: 120 }); // the site's own Search batch
    expect(publicPageArgs(0, 0)).toEqual({ page: 1, limit: 20 });
    expect(publicPageArgs("abc", "-5")).toEqual({ page: 1, limit: 1 });
    expect(publicPageArgs(undefined, undefined)).toEqual({ page: 1, limit: 20 });
  });
});
