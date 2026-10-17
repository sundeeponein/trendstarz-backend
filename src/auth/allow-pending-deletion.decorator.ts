import { SetMetadata } from "@nestjs/common";

/**
 * Marks a route as reachable by an account with status "deletion_pending" —
 * JwtAuthGuard blocks deleted/deletion_pending accounts from every other
 * authenticated endpoint, but the account owner must still be able to view
 * their deletion status and cancel it during the grace period.
 */
export const ALLOW_PENDING_DELETION_KEY = "allowPendingDeletion";
export const AllowPendingDeletion = () =>
  SetMetadata(ALLOW_PENDING_DELETION_KEY, true);
