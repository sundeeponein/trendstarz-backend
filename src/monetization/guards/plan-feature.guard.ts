import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { PlansService } from "../../plans/plans.service";
import { PLAN_FEATURE_METADATA_KEY } from "../decorators/plan-feature.decorator";

@Injectable()
export class PlanFeatureGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly plansService: PlansService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredFeature = this.reflector.getAllAndOverride<string>(
      PLAN_FEATURE_METADATA_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!requiredFeature) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const userId = String(request?.user?.userId || "").trim();
    if (!userId) {
      throw new ForbiddenException("Authentication required");
    }

    const caps = await this.plansService.getUserPlanCapabilities(userId);
    const hasFeature = (caps?.features || []).some(
      (f: any) => String(f?.key || "") === requiredFeature && !!f?.value,
    );

    if (!hasFeature) {
      throw new ForbiddenException(
        "Upgrade to Premium to access this feature.",
      );
    }

    return true;
  }
}
