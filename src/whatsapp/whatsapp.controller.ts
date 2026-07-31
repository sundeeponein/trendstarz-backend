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

/**
 * Redirect target for Meta's Embedded Signup OAuth flow. Currently a stub:
 * it accepts the redirect so the config can be saved in the Meta dashboard,
 * but does not yet exchange `code` for a WABA access token — that requires
 * META_APP_ID / META_APP_SECRET (not yet configured) and a storage decision
 * for the resulting WABA id / phone number id.
 */
@Controller("whatsapp/embedded-signup")
export class WhatsAppEmbeddedSignupController {
  private readonly logger = new Logger(WhatsAppEmbeddedSignupController.name);

  @Get("callback")
  callback(@Query() query: Record<string, string>, @Res() res: Response) {
    const { code, state, error, error_description } = query;

    if (error) {
      this.logger.warn(
        `Embedded signup OAuth denied/cancelled: ${error} - ${error_description}`,
      );
      return res.status(200).send("WhatsApp signup was cancelled.");
    }

    if (!code) {
      return res.status(400).send("Missing authorization code");
    }

    this.logger.log(`Embedded signup callback received code (state=${state})`);
    // TODO: exchange `code` for a business access token via the Graph API
    // and persist the resulting WABA id / phone number id once wired up.
    return res
      .status(200)
      .send("WhatsApp signup received. You can close this window.");
  }
}
