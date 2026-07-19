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

interface AccountStatusGuardMetrics {
  checksFailed: number;
  timeouts: number;
  staleFallbackUsed: number;
  failOpenWithoutCache: number;
  lastFailureAt: string | null;
}

// Deliberately NOT injected via @InjectModel: JwtAuthGuard is applied via
// bare `@UseGuards(JwtAuthGuard)` across dozens of controllers/modules with
// no single owning module, so constructor-injected Mongoose models would
// fail to resolve in any module that doesn't itself register them. Reading
// straight off the global Mongoose model registry (this app uses a single
// default connection — see MongooseModule.forRoot in app.module.ts) avoids
// that entirely.
const ACCOUNT_STATUS_CACHE_TTL_MS = 60 * 1000;
const ACCOUNT_STATUS_STALE_GRACE_MS = 10 * 60 * 1000;
const accountStatusCache = new Map<string, AccountStatusEntry>();

// Mongoose's default command-buffering timeout is 10s (serverSelectionTimeoutMS
// is 8s on top of that) — during a DB hiccup this guard would otherwise stall
// EVERY authenticated request app-wide for up to 10s before falling back to
// canActivate's fail-open catch. Bound our own wait far below that so a Mongo
// blip degrades to "a bit slower," not "every request hangs for 10 seconds."
const ACCOUNT_STATUS_QUERY_TIMEOUT_MS = 1500;
const ACCOUNT_STATUS_ERROR_LOG_THROTTLE_MS = 60 * 1000;
let lastAccountStatusErrorLogAt = 0;
const accountStatusGuardMetrics: AccountStatusGuardMetrics = {
  checksFailed: 0,
  timeouts: 0,
  staleFallbackUsed: 0,
  failOpenWithoutCache: 0,
  lastFailureAt: null,
};

const ROLE_MODEL_NAME: Record<string, string> = {
  influencer: "Influencer",
  brand: "Brand",
  photographer: "Photographer",
};

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Account-status query timed out after ${ms}ms`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

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

  const doc: any = await withTimeout(
    model
      .findById(userId)
      .select("isDeleted status")
      .maxTimeMS(ACCOUNT_STATUS_QUERY_TIMEOUT_MS)
      .lean()
      .exec(),
    ACCOUNT_STATUS_QUERY_TIMEOUT_MS,
  );
  if (!doc) return null;

  const entry: AccountStatusEntry = {
    isDeleted: !!doc.isDeleted,
    status: String(doc.status || ""),
    expiresAt: Date.now() + ACCOUNT_STATUS_CACHE_TTL_MS,
  };
  accountStatusCache.set(userId, entry);
  return entry;
}

function getStaleAccountStatus(userId: string): AccountStatusEntry | null {
  const cached = accountStatusCache.get(userId);
  if (!cached) return null;
  if (Date.now() - cached.expiresAt > ACCOUNT_STATUS_STALE_GRACE_MS) {
    return null;
  }
  return cached;
}

function markAccountStatusGuardFailure(err: unknown): void {
  accountStatusGuardMetrics.checksFailed += 1;
  accountStatusGuardMetrics.lastFailureAt = new Date().toISOString();
  const message = err instanceof Error ? err.message : String(err || "");
  if (/timed out/i.test(message)) {
    accountStatusGuardMetrics.timeouts += 1;
  }
}

function logAccountStatusErrorThrottled(err: unknown): void {
  const now = Date.now();
  if (now - lastAccountStatusErrorLogAt < ACCOUNT_STATUS_ERROR_LOG_THROTTLE_MS) {
    return;
  }
  lastAccountStatusErrorLogAt = now;
  console.error("JwtAuthGuard account-status check failed:", {
    error: err,
    metrics: { ...accountStatusGuardMetrics },
  });
}

/** Called by UsersService whenever isDeleted/status changes, so a deletion
 * or restore takes effect on the very next request instead of waiting out
 * the cache TTL. */
export function invalidateAccountStatusCache(userId: string): void {
  accountStatusCache.delete(String(userId));
}

export function getJwtAuthGuardAccountStatusMetrics(): AccountStatusGuardMetrics {
  return { ...accountStatusGuardMetrics };
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
      markAccountStatusGuardFailure(err);
      logAccountStatusErrorThrottled(err);
      account = getStaleAccountStatus(String(decoded.userId));
      if (account) {
        accountStatusGuardMetrics.staleFallbackUsed += 1;
      } else {
        accountStatusGuardMetrics.failOpenWithoutCache += 1;
        return true;
      }
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
