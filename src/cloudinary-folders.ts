// Centralized Cloudinary folder-naming convention. Entities are organized by
// their own Mongo _id so admins can browse/clean up per-user or per-campaign
// assets directly in the Cloudinary console.
//
//   influencers/{influencerId}/{profile,gallery,verification}/
//   photographers/{photographerId}/{profile,gallery,verification}/
//   brands/{brandId}/{logo,products}/
//   campaigns/{campaignId}/{images,proofs/{submitterId}}/
//
// The entity's _id doesn't exist yet at upload time during registration (and
// during new-campaign creation), so those flows upload into a `_pending`
// staging path first and get relocated into their final folder once the
// document (and its _id) is created.

const PENDING = "_pending";

export const CloudinaryFolders = {
  influencer: {
    pendingProfile: `influencers/${PENDING}/profile`,
    pendingGallery: `influencers/${PENDING}/gallery`,
    pendingVerification: `influencers/${PENDING}/verification`,
    profile: (id: string) => `influencers/${id}/profile`,
    gallery: (id: string) => `influencers/${id}/gallery`,
    verification: (id: string) => `influencers/${id}/verification`,
  },
  brand: {
    pendingLogo: `brands/${PENDING}/logo`,
    pendingProducts: `brands/${PENDING}/products`,
    logo: (id: string) => `brands/${id}/logo`,
    products: (id: string) => `brands/${id}/products`,
  },
  photographer: {
    pendingProfile: `photographers/${PENDING}/profile`,
    pendingGallery: `photographers/${PENDING}/gallery`,
    pendingVerification: `photographers/${PENDING}/verification`,
    profile: (id: string) => `photographers/${id}/profile`,
    gallery: (id: string) => `photographers/${id}/gallery`,
    verification: (id: string) => `photographers/${id}/verification`,
  },
  campaign: {
    pendingImages: `campaigns/${PENDING}/images`,
    images: (id: string) => `campaigns/${id}/images`,
    proofs: (campaignId: string, submitterId: string) =>
      `campaigns/${campaignId}/proofs/${submitterId}`,
  },
};
