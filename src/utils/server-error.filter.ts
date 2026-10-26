import { ArgumentsHost, Catch, HttpException, Logger } from "@nestjs/common";
import { BaseExceptionFilter } from "@nestjs/core";
import type { Collection } from "mongodb";

/** 5xx errors (route pattern, status, short message — never bodies or ids); kept 30 days. */
export const SERVER_ERRORS = "server_errors";
export const SERVER_ERRORS_KEEP_DAYS = 30;
let errorLog: Collection<any> | null = null;

/** Connected at startup (DataIntegrityService.onModuleInit). */
export function setServerErrorCollection(collection: Collection<any> | null) {
  errorLog = collection;
}

/** What gets stored for one failure: no request body, no query, no ids from the URL. */
export function serverErrorRecord(req: any, status: number, err: any) {
  const route = String(req?.route?.path || req?.baseUrl || "")
    || String(req?.originalUrl || req?.url || "").split("?")[0].replace(/[a-f0-9]{24}/gi, ":id");
  return {
    at: new Date(),
    method: String(req?.method || ""),
    route: route.slice(0, 200),
    status,
    error: String(err?.name || "Error").slice(0, 60),
    message: String(err?.message || err || "").replace(/\S+@\S+/g, "[email]").slice(0, 200),
  };
}

/**
 * Records server errors (5xx) so a broken feature shows on Data health the next
 * morning instead of only in the Railway log. Responses are unchanged: Nest's own
 * BaseExceptionFilter still answers.
 */
@Catch()
export class ServerErrorFilter extends BaseExceptionFilter {
  private readonly logger = new Logger("ServerError");

  catch(exception: unknown, host: ArgumentsHost) {
    const status = exception instanceof HttpException ? exception.getStatus() : 500;
    if (status >= 500 && host.getType() === "http") {
      const req = host.switchToHttp().getRequest();
      const row = serverErrorRecord(req, status, exception);
      this.logger.error(`${row.method} ${row.route} → ${status}: ${row.message}`);
      errorLog?.insertOne(row).catch(() => undefined);
    }
    super.catch(exception, host);
  }
}
