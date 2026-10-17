import {
  BadRequestException,
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from "@nestjs/common";
import { Observable } from "rxjs";

/**
 * Most request bodies are not DTO classes, so nothing checks their shape. A
 * value like `{ "email": { "$ne": null } }` would reach a Mongo filter as an
 * operator instead of a value. No legitimate client sends `$`-prefixed keys,
 * so any request carrying one (in the body or query, at any depth) is refused.
 */
export function findOperatorKey(value: unknown, depth = 0): string | null {
  if (depth > 20 || value === null || typeof value !== "object") return null;
  if (Buffer.isBuffer(value) || value instanceof Date) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = findOperatorKey(item, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key.startsWith("$")) return key;
    const hit = findOperatorKey(child, depth + 1);
    if (hit) return hit;
  }
  return null;
}

@Injectable()
export class RejectOperatorKeysInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest();
    const key = findOperatorKey(req?.body) || findOperatorKey(req?.query);
    if (key) {
      throw new BadRequestException(`Invalid field name "${key}".`);
    }
    return next.handle();
  }
}
