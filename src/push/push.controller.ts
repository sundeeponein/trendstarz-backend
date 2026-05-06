import { Body, Controller, Delete, Get, Post, Req, UseGuards } from "@nestjs/common";
import { PushService } from "./push.service";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";

@Controller("push")
export class PushController {
  constructor(private readonly pushService: PushService) {}

  /** Return the VAPID public key so the frontend can create a subscription. */
  @Get("vapid-public-key")
  getVapidPublicKey() {
    return { key: process.env.VAPID_PUBLIC_KEY };
  }

  /** Save a push subscription for the logged-in user. */
  @Post("subscribe")
  @UseGuards(JwtAuthGuard)
  subscribe(
    @Req() req: any,
    @Body()
    body: {
      subscription: {
        endpoint: string;
        keys: { p256dh: string; auth: string };
      };
      userRole?: string;
    },
  ) {
    const userId: string = req.user?.userId || req.user?.sub;
    return this.pushService.subscribe(
      userId,
      body.userRole || "influencer",
      body.subscription,
    );
  }

  /** Remove a push subscription (e.g. on logout or permission revoke). */
  @Delete("unsubscribe")
  @UseGuards(JwtAuthGuard)
  unsubscribe(@Body() body: { endpoint: string }) {
    return this.pushService.unsubscribe(body.endpoint);
  }
}
