import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import { PlansService } from "../../plans/plans.service";
import {
  USAGE_LIMIT_METADATA_KEY,
  UsageLimitMetadata,
} from "../decorators/usage-limit.decorator";

function toDayKey(date = new Date()): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

@Injectable()
export class DailyUsageGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly plansService: PlansService,
    @InjectModel("UsageCounter") private readonly usageModel: Model<any>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const usageMeta = this.reflector.getAllAndOverride<UsageLimitMetadata>(
      USAGE_LIMIT_METADATA_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!usageMeta) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const userId = String(request?.user?.userId || "").trim();
    const role = String(request?.user?.role || "").toLowerCase();
    if (!userId || !role) {
      throw new ForbiddenException("Authentication required");
    }

    const caps = await this.plansService.getUserPlanCapabilities(userId);
    const limitEntry = (caps?.limits || []).find(
      (l: any) => String(l?.key || "") === usageMeta.limitKey,
    );
    const maxLimit = Number(limitEntry?.value ?? 0);

    if (maxLimit <= 0) {
      throw new ForbiddenException(
        "Daily limit reached. Upgrade your plan for higher limits.",
      );
    }

    const day = toDayKey();
    const usageType = usageMeta.metric === "search" ? "search" : "profile_view";

    const doc = await this.usageModel.findOneAndUpdate(
      {
        userId,
        userRole: role,
        usageType,
        day,
      },
      {
        $setOnInsert: {
          userId,
          userRole: role,
          usageType,
          day,
          used: 0,
        },
      },
      { new: true, upsert: true },
    );

    if ((doc?.used || 0) >= maxLimit) {
      throw new ForbiddenException(
        "You have exhausted today's usage limit. Please upgrade your plan.",
      );
    }

    const updated = await this.usageModel.findByIdAndUpdate(
      doc._id,
      {
        $inc: { used: 1 },
        $set: { limit: maxLimit, remaining: Math.max(maxLimit - ((doc?.used || 0) + 1), 0) },
      },
      { new: true },
    );

    request.usage = {
      metric: usageMeta.metric,
      used: updated?.used ?? 0,
      remaining: updated?.remaining ?? 0,
      limit: maxLimit,
      day,
    };

    return true;
  }
}
