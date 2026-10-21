import { Body, Controller, Delete, Get, Patch, Post, Req, UseGuards } from "@nestjs/common";
import { PushService } from "./push.service";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";

function detectDeviceType(userAgent: string | undefined): "web" | "mobile" {
  if (!userAgent) return "web";
  return /Mobi|Android|iPhone|iPad|iPod/i.test(userAgent) ? "mobile" : "web";
}

/** The stored role comes from the login token, never from the request body. */
function pushRoleFromToken(role: unknown): "brand" | "influencer" | "photographer" | "admin" {
  const value = String(role || "").toLowerCase();
  if (value === "admin" || value === "subadmin") return "admin";
  if (value === "brand" || value === "photographer") return value;
  return "influencer";
}

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
    },
  ) {
    const userId: string = req.user?.userId || req.user?.sub;
    const deviceType = detectDeviceType(req.headers?.["user-agent"]);
    return this.pushService.subscribe(
      userId,
      pushRoleFromToken(req.user?.role),
      body?.subscription,
      deviceType,
    );
  }

  /** Remove a push subscription (e.g. on logout or permission revoke). */
  @Delete("unsubscribe")
  @UseGuards(JwtAuthGuard)
  unsubscribe(@Req() req: any, @Body() body: { endpoint: string }) {
    const userId: string = req.user?.userId || req.user?.sub;
    return this.pushService.unsubscribe(userId, body?.endpoint);
  }

  /** Get the logged-in user's account-level push preference (device + category). */
  @Get("preferences")
  @UseGuards(JwtAuthGuard)
  getPreferences(@Req() req: any) {
    const userId: string = req.user?.userId || req.user?.sub;
    return this.pushService.getPreferences(userId);
  }

  /** Update the logged-in user's account-level push preference (device + category). */
  @Patch("preferences")
  @UseGuards(JwtAuthGuard)
  setPreferences(
    @Req() req: any,
    @Body()
    body: {
      webEnabled?: boolean;
      mobileEnabled?: boolean;
      campaignEnabled?: boolean;
      paymentEnabled?: boolean;
      whatsappEnabled?: boolean;
    },
  ) {
    const userId: string = req.user?.userId || req.user?.sub;
    return this.pushService.setPreferences(userId, body);
  }
}
