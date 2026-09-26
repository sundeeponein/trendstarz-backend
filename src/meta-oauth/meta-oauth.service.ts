import { Injectable, Logger } from "@nestjs/common";
import axios from "axios";

const GRAPH_API_BASE = "https://graph.facebook.com/v21.0";
const OAUTH_DIALOG_BASE = "https://www.facebook.com/v21.0/dialog/oauth";

export interface MetaTokenResult {
  accessToken: string;
  expiresInSeconds: number | null;
}

export interface MetaFacebookPage {
  id: string;
  name: string;
  followersCount: number;
  instagramBusinessAccountId: string | null;
}

/**
 * Shared Meta Graph API OAuth client — used by
 * InstagramCollectorService/FacebookCollectorService, and reusable later by
 * the WhatsApp Business Embedded Signup callback (whatsapp.controller.ts),
 * which references the same META_APP_ID/META_APP_SECRET but never finished
 * its own token exchange. Mirrors razorpay.service.ts's lazy-credential-
 * check convention — throws a clear error if env vars are missing rather
 * than failing deep inside a Graph API call.
 */
@Injectable()
export class MetaOAuthService {
  private readonly logger = new Logger(MetaOAuthService.name);

  private getCredentials(): { appId: string; appSecret: string; redirectUri: string } {
    const appId = process.env.META_APP_ID;
    const appSecret = process.env.META_APP_SECRET;
    const redirectUri = process.env.META_OAUTH_REDIRECT_URI;
    if (!appId || !appSecret || !redirectUri) {
      throw new Error(
        "Missing META_APP_ID, META_APP_SECRET, or META_OAUTH_REDIRECT_URI in environment variables. Please check your .env file.",
      );
    }
    return { appId, appSecret, redirectUri };
  }

  isConfigured(): boolean {
    return !!(process.env.META_APP_ID && process.env.META_APP_SECRET && process.env.META_OAUTH_REDIRECT_URI);
  }

  getAuthorizationUrl(state: string, scopes: string[]): string {
    const { appId, redirectUri } = this.getCredentials();
    const params = new URLSearchParams({
      client_id: appId,
      redirect_uri: redirectUri,
      state,
      scope: scopes.join(","),
      response_type: "code",
    });
    return `${OAUTH_DIALOG_BASE}?${params.toString()}`;
  }

  async exchangeCodeForToken(code: string): Promise<MetaTokenResult> {
    const { appId, appSecret, redirectUri } = this.getCredentials();
    const resp = await axios.get(`${GRAPH_API_BASE}/oauth/access_token`, {
      params: { client_id: appId, client_secret: appSecret, redirect_uri: redirectUri, code },
    });
    return {
      accessToken: resp.data?.access_token,
      expiresInSeconds: resp.data?.expires_in ?? null,
    };
  }

  async exchangeForLongLivedToken(shortLivedToken: string): Promise<MetaTokenResult> {
    const { appId, appSecret } = this.getCredentials();
    const resp = await axios.get(`${GRAPH_API_BASE}/oauth/access_token`, {
      params: {
        grant_type: "fb_exchange_token",
        client_id: appId,
        client_secret: appSecret,
        fb_exchange_token: shortLivedToken,
      },
    });
    return {
      accessToken: resp.data?.access_token,
      expiresInSeconds: resp.data?.expires_in ?? null,
    };
  }

  /** Long-lived Page/User tokens can be refreshed the same way as the initial long-lived exchange. */
  async refreshLongLivedToken(currentToken: string): Promise<MetaTokenResult> {
    return this.exchangeForLongLivedToken(currentToken);
  }

  async resolveFacebookPages(accessToken: string): Promise<MetaFacebookPage[]> {
    try {
      const resp = await axios.get(`${GRAPH_API_BASE}/me/accounts`, {
        params: { access_token: accessToken, fields: "id,name,followers_count,instagram_business_account" },
      });
      const pages: any[] = resp.data?.data || [];
      return pages.map((p) => ({
        id: p.id,
        name: p.name,
        followersCount: Number(p.followers_count || 0),
        instagramBusinessAccountId: p.instagram_business_account?.id || null,
      }));
    } catch (err: any) {
      this.logger.warn(`Failed to resolve Facebook pages: ${err?.message || err}`);
      return [];
    }
  }

  async getFacebookPageStats(
    pageId: string,
    accessToken: string,
  ): Promise<{ followersCount: number; posts: Array<{ likes: number; comments: number; createdAt: Date }> } | null> {
    try {
      const [pageResp, postsResp] = await Promise.all([
        axios.get(`${GRAPH_API_BASE}/${pageId}`, {
          params: { access_token: accessToken, fields: "followers_count" },
        }),
        axios.get(`${GRAPH_API_BASE}/${pageId}/posts`, {
          params: {
            access_token: accessToken,
            fields: "likes.summary(true),comments.summary(true),created_time",
            limit: 20,
          },
        }),
      ]);
      const posts: any[] = postsResp.data?.data || [];
      return {
        followersCount: Number(pageResp.data?.followers_count || 0),
        posts: posts.map((p) => ({
          likes: Number(p.likes?.summary?.total_count || 0),
          comments: Number(p.comments?.summary?.total_count || 0),
          createdAt: new Date(p.created_time || Date.now()),
        })),
      };
    } catch (err: any) {
      this.logger.warn(`Failed to fetch Facebook page stats for ${pageId}: ${err?.message || err}`);
      return null;
    }
  }

  async getInstagramBusinessAccountStats(
    igAccountId: string,
    accessToken: string,
  ): Promise<{
    username: string | null;
    followersCount: number;
    posts: Array<{ likes: number; comments: number; createdAt: Date }>;
  } | null> {
    try {
      const [accountResp, mediaResp] = await Promise.all([
        axios.get(`${GRAPH_API_BASE}/${igAccountId}`, {
          params: { access_token: accessToken, fields: "followers_count,username" },
        }),
        axios.get(`${GRAPH_API_BASE}/${igAccountId}/media`, {
          params: { access_token: accessToken, fields: "like_count,comments_count,timestamp", limit: 20 },
        }),
      ]);
      const media: any[] = mediaResp.data?.data || [];
      return {
        username: accountResp.data?.username || null,
        followersCount: Number(accountResp.data?.followers_count || 0),
        posts: media.map((m) => ({
          likes: Number(m.like_count || 0),
          comments: Number(m.comments_count || 0),
          createdAt: new Date(m.timestamp || Date.now()),
        })),
      };
    } catch (err: any) {
      this.logger.warn(`Failed to fetch Instagram business account stats for ${igAccountId}: ${err?.message || err}`);
      return null;
    }
  }

  /** Revokes the connection server-side too, best-effort — never blocks a local disconnect. */
  async revokePermissions(metaUserOrPageId: string, accessToken: string): Promise<void> {
    try {
      await axios.delete(`${GRAPH_API_BASE}/${metaUserOrPageId}/permissions`, {
        params: { access_token: accessToken },
      });
    } catch (err: any) {
      this.logger.warn(`Failed to revoke Meta permissions for ${metaUserOrPageId}: ${err?.message || err}`);
    }
  }
}
