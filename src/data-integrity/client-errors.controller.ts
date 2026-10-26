import { Body, Controller, HttpCode, Post } from "@nestjs/common";
import { InjectConnection } from "@nestjs/mongoose";
import { Throttle } from "@nestjs/throttler";
import type { Connection } from "mongoose";

/** Errors users hit in the page itself (a broken button or screen); kept 30 days. */
export const CLIENT_ERRORS = "client_errors";
export const CLIENT_ERRORS_KEEP_DAYS = 30;

const clean = (v: unknown, max: number) =>
  String(v ?? "")
    .replace(/\S+@\S+/g, "[email]")
    .replace(/[a-f0-9]{24}/gi, ":id")
    .slice(0, max);

/** Public (errors happen before login too) but throttled; stores no body, cookie or user data. */
@Controller("client-errors")
export class ClientErrorsController {
  constructor(@InjectConnection() private readonly connection: Connection) {}

  @Post()
  @HttpCode(204)
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  async report(@Body() body: any): Promise<void> {
    const message = clean(body?.message, 300);
    if (!message) return;
    await this.connection
      .db!.collection(CLIENT_ERRORS)
      .insertOne({
        at: new Date(),
        page: clean(body?.page, 150).split("?")[0],
        name: clean(body?.name, 60),
        message,
        browser: clean(body?.browser, 120),
      })
      .catch(() => undefined);
  }
}
