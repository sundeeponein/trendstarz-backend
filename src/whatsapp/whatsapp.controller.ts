import {
  Body,
  Controller,
  Get,
  Logger,
  Post,
  Query,
  Res,
} from "@nestjs/common";
import type { Response } from "express";

/**
 * Meta requires the GET verification challenge to be echoed back as a raw
 * text body (not wrapped by the global ResponseInterceptor), hence @Res().
 */
@Controller("webhooks/whatsapp")
export class WhatsAppWebhookController {
  private readonly logger = new Logger(WhatsAppWebhookController.name);

  @Get()
  verify(@Query() query: Record<string, string>, @Res() res: Response) {
    const mode = query["hub.mode"];
    const token = query["hub.verify_token"];
    const challenge = query["hub.challenge"];

    if (mode === "subscribe" && token === process.env.WHATSAPP_VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    this.logger.warn(`WhatsApp webhook verification failed: mode=${mode}`);
    return res.status(403).send("Forbidden");
  }

  @Post()
  receive(@Body() body: any, @Res() res: Response) {
    // Meta requires a fast 200 ack; message handling can be added here later.
    this.logger.log(`WhatsApp webhook event received: ${JSON.stringify(body)}`);
    return res.status(200).send("EVENT_RECEIVED");
  }
}
