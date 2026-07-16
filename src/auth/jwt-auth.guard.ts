import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import * as jwt from "jsonwebtoken";
import * as mongoose from "mongoose";
import { getJwtSecret } from "./jwt-secret";
import { ALLOW_PENDING_DELETION_KEY } from "./allow-pending-deletion.decorator";

interface AccountStatusEntry {
  isDeleted: boolean;
  status: string;
  expiresAt: number;
}

// Deliberately NOT injected via @InjectModel: JwtAuthGuard is applied via
// bare `@UseGuards(JwtAuthGuard)` across dozens of controllers/modules with
// no single owning module, so constructor-injected Mongoose models would
// fail to resolve in any module that doesn't itself register them. Reading
// straight off the global Mongoose model registry (this app uses a single
// default connection — see MongooseModule.forRoot in app.module.ts) avoids
// that entirely.
const ACCOUNT_STATUS_CACHE_TTL_MS = 60 * 1000;
const accountStatusCache = new Map<string, AccountStatusEntry>();

const ROLE_MODEL_NAME: Record<string, string> = {
  influencer: "Influencer",
  brand: "Brand",
  photographer: "Photographer",
};

async function getAccountStatus(
  userId: string,
  role: string,
): Promise<AccountStatusEntry | null> {
  const cached = accountStatusCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) return cached;

  const modelName = ROLE_MODEL_NAME[String(role || "").toLowerCase()];
  if (!modelName) return null;
  const model = mongoose.models[modelName];
  if (!model) return null;

  const doc: any = await model
    .findById(userId)
    .select("isDeleted status")
    .lean();
  if (!doc) return null;

  const entry: AccountStatusEntry = {
    isDeleted: !!doc.isDeleted,
    status: String(doc.status || ""),
    expiresAt: Date.now() + ACCOUNT_STATUS_CACHE_TTL_MS,
  };
  accountStatusCache.set(userId, entry);
  return entry;
}

/** Called by UsersService whenever isDeleted/status changes, so a deletion
 * or restore takes effect on the very next request instead of waiting out
 * the cache TTL. */
export function invalidateAccountStatusCache(userId: string): void {
  accountStatusCache.delete(String(userId));
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const authHeader = req.headers["authorization"];
    if (!authHeader) throw new UnauthorizedException("No token provided");
    const token = authHeader.split(" ")[1];

    let decoded: any;
    try {
      decoded = jwt.verify(token, getJwtSecret());
    } catch {
      throw new UnauthorizedException("Invalid token");
    }
    req.user = decoded;

    // Admin/subadmin accounts aren't self-deletable — skip the lookup.
    const role = String(decoded?.role || "").toLowerCase();
    if (!decoded?.userId || !ROLE_MODEL_NAME[role]) {
      return true;
    }

    let account: AccountStatusEntry | null = null;
    try {
      account = await getAccountStatus(String(decoded.userId), role);
    } catch (err) {
      // Fail OPEN on a transient DB hiccup — a status-check outage must
      // never turn into an app-wide authentication outage.
      console.error("JwtAuthGuard account-status check failed:", err);
      return true;
    }

    if (account?.isDeleted) {
      const allowPendingDeletion = this.reflector.getAllAndOverride<boolean>(
        ALLOW_PENDING_DELETION_KEY,
        [context.getHandler(), context.getClass()],
      );
      if (account.status === "deletion_pending" && allowPendingDeletion) {
        return true;
      }
      throw new UnauthorizedException(
        "Your account has been deleted. Please contact support.",
      );
    }

    return true;
  }
}
