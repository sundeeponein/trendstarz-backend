import { FirebaseAdminService } from "./firebase-admin.service";

/** A tiny in-memory stand-in for Firebase Auth. */
function fakeAuth(users: Array<{ uid: string; email: string }>) {
  const byEmail = () => new Map(users.map((u) => [u.email, u]));
  const notFound = () => Object.assign(new Error("not found"), { code: "auth/user-not-found" });
  return {
    users,
    getUserByEmail: async (email: string) => {
      const u = byEmail().get(email);
      if (!u) throw notFound();
      return u;
    },
    updateUser: async (uid: string, patch: any) => {
      const u = users.find((x) => x.uid === uid)!;
      Object.assign(u, patch);
      return u;
    },
    deleteUser: async (uid: string) => {
      users.splice(users.findIndex((x) => x.uid === uid), 1);
    },
  };
}

const serviceWith = (auth: any) =>
  Object.assign(Object.create(FirebaseAdminService.prototype), {
    isConfigured: () => true,
    getApp: () => ({ auth: () => auth }),
  }) as FirebaseAdminService;

describe("FirebaseAdminService.moveLoginEmail", () => {
  it("moves the old login to the new address", async () => {
    const auth = fakeAuth([{ uid: "u1", email: "old@x.in" }]);
    await expect(serviceWith(auth).moveLoginEmail("Old@x.in", "new@x.in")).resolves.toBe("u1");
    expect(auth.users).toEqual([{ uid: "u1", email: "new@x.in", emailVerified: false }]);
  });

  it("deletes the old login when the new address already has one", async () => {
    const auth = fakeAuth([{ uid: "u1", email: "old@x.in" }, { uid: "u2", email: "new@x.in" }]);
    await expect(serviceWith(auth).moveLoginEmail("old@x.in", "new@x.in")).resolves.toBe("u2");
    expect(auth.users.map((u) => u.uid)).toEqual(["u2"]);
  });

  it("does nothing without an old login, or when the email didn't change", async () => {
    const auth = fakeAuth([{ uid: "u2", email: "new@x.in" }]);
    await expect(serviceWith(auth).moveLoginEmail("old@x.in", "new@x.in")).resolves.toBe("u2");
    await expect(serviceWith(auth).moveLoginEmail("new@x.in", "NEW@x.in")).resolves.toBeNull();
    expect(auth.users).toHaveLength(1);
  });
});
