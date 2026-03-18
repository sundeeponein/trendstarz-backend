import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from "@nestjs/common";
import { Observable } from "rxjs";
import { map } from "rxjs/operators";

@Injectable()
export class ResponseInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    return next.handle().pipe(
      map((data) => {
        // Skip wrapping if the response is already wrapped or is a redirect
        if (data && typeof data === "object" && "success" in data) {
          return data;
        }
        return { success: true, data };
      }),
    );
  }
}
