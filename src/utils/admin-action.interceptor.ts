import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  SetMetadata,
  UseInterceptors,
  applyDecorators,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { tap } from "rxjs/operators";
import { recordAdminAction, summarizeBody } from "./admin-action-log.util";

const ADMIN_ACTION = "adminAction";

/** After the request succeeds, writes who did it to admin_actions (see admin-action-log.util). */
@Injectable()
export class AdminActionInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler) {
    const action = this.reflector.get<string>(ADMIN_ACTION, context.getHandler());
    const req = context.switchToHttp().getRequest();
    return next.handle().pipe(
      tap(() => {
        if (!action) return;
        const params = req?.params || {};
        void recordAdminAction(
          req,
          action,
          {
            type: String(params.type || params.userType || req?.body?.type || "account"),
            id: String(params.id || params.userId || ""),
          },
          summarizeBody(req?.body),
        );
      }),
    );
  }
}

/** Marks an admin endpoint whose successful calls are recorded in admin_actions. */
export const LogAdminAction = (action: string) =>
  applyDecorators(SetMetadata(ADMIN_ACTION, action), UseInterceptors(AdminActionInterceptor));
