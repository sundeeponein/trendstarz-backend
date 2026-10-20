import { PendingUploadCleanupService } from "./pending-upload-cleanup.service";

describe("PendingUploadCleanupService — never deletes a live upload", () => {
  const model = (docs: any[]) => ({ find: () => ({ lean: async () => docs }) });

  it("skips old staged files still referenced by any profile field, deletes true orphans", async () => {
    const deleted: string[] = [];
    const service = new PendingUploadCleanupService(
      {
        findOne: () => ({ lean: async () => ({ pendingUploadAutoDeleteEnabled: true, pendingUploadAutoDeleteHours: 48 }) }),
        findOneAndUpdate: async () => ({}),
      } as any,
      model([
        {
          profileImagePublicId: "influencers/_pending/profile/a",
          galleryImages: [{ publicId: "influencers/_pending/gallery/b" }],
          profileImages: ["influencers/_pending/gallery/c"],
        },
      ]) as any,
      model([]) as any,
      model([]) as any,
      {
        listResourcesOlderThan: async (prefix: string) =>
          prefix === "influencers/_pending/gallery"
            ? [
                { public_id: "influencers/_pending/gallery/b" },
                { public_id: "influencers/_pending/gallery/c" },
                { public_id: "influencers/_pending/gallery/orphan" },
              ]
            : prefix === "influencers/_pending/profile"
              ? [{ public_id: "influencers/_pending/profile/a" }]
              : [],
        deleteImage: async (id: string) => {
          deleted.push(id);
          return { result: "ok" };
        },
      } as any,
    );
    const result = await service.runCleanupNow("test");
    expect(deleted).toEqual(["influencers/_pending/gallery/orphan"]);
    expect(result.totalSkippedInUse).toBe(3);
  });
});
