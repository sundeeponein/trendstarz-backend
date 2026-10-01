import { Injectable, Logger } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import axios from "axios";
import { Model } from "mongoose";
import {
  ObservationFailureReason,
  ObservationSource,
} from "../database/schemas/social-account-observation.schema";
import { SocialProfileType } from "../database/schemas/social-account-verification.schema";
import {
  MetaGraphError,
  MetaOAuthService,
} from "../meta-oauth/meta-oauth.service";

/**
 * Stage 3A-2 — platform observers. Each resolves the EXACT external account a
 * TrendStarZ social account refers to, or fails with a safe reason. No search,
 * no "first result", no fuzzy/name matching. Observers only read from the
 * platform; persistence lives in SocialAccountObservationService.
 */

export interface ObservedAccountData {
  source: ObservationSource;
  externalAccountId: string;
  observedHandle: string;
  observedFollowersCount: number | null;
  externalUrl: string;
  rawPlatformUpdatedAt: Date | null;
}

export type ObservationOutcome =
  | { ok: true; data: ObservedAccountData }
  | { ok: false; reason: ObservationFailureReason };

const fail = (reason: ObservationFailureReason): ObservationOutcome => ({
  ok: false,
  reason,
});

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function finiteOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Parses an http(s) URL on one of `hosts`, tolerating a missing scheme. Null otherwise. */
function parseUrlOn(raw: string, hosts: RegExp): URL | null {
  if (!/^(https?:\/\/)?[^/\s]+\.[a-z]{2,}\//i.test(raw)) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    return hosts.test(url.hostname) ? url : null;
  } catch {
    return null;
  }
}

// ── YouTube ────────────────────────────────────────────────────────────────

const YOUTUBE_API_BASE = "https://www.googleapis.com/youtube/v3";
const YT_CHANNEL_ID_RE = /^UC[A-Za-z0-9_-]{22}$/;
const YT_HANDLE_RE = /^[A-Za-z0-9._-]{3,30}$/;
const YT_HOSTS = /^((www|m)\.)?youtube\.com$/i;

export type YouTubeIdentifier =
  | { kind: "channelId"; value: string }
  | { kind: "handle"; value: string };

/**
 * The exact identifier in a declared YouTube handle, or null when there isn't
 * one. Accepts a channel id, "handle", "@handle", youtube.com/@handle and
 * youtube.com/channel/UC… — only harmless spelling differences are removed.
 * Legacy /c/ and /user/ URLs, video links and free text are NOT exact
 * identifiers and return null (never searched).
 */
export function parseYouTubeIdentifier(raw: unknown): YouTubeIdentifier | null {
  const value = text(raw);
  if (!value) return null;

  const url = parseUrlOn(value, YT_HOSTS);
  if (url) {
    const [first, second] = url.pathname.split("/").filter(Boolean);
    if (first === "channel" && second && YT_CHANNEL_ID_RE.test(second)) {
      return { kind: "channelId", value: second };
    }
    if (first?.startsWith("@") && YT_HANDLE_RE.test(first.slice(1))) {
      return { kind: "handle", value: first.slice(1) };
    }
    return null;
  }
  if (/[/\s?#]/.test(value)) return null;
  if (YT_CHANNEL_ID_RE.test(value)) return { kind: "channelId", value };
  const handle = value.startsWith("@") ? value.slice(1) : value;
  return YT_HANDLE_RE.test(handle) ? { kind: "handle", value: handle } : null;
}

interface YouTubeChannel {
  id?: unknown;
  snippet?: { customUrl?: unknown };
  statistics?: { subscriberCount?: unknown; hiddenSubscriberCount?: unknown };
}

@Injectable()
export class YoutubeObserver {
  private readonly logger = new Logger(YoutubeObserver.name);

  async observe(declaredHandle: unknown): Promise<ObservationOutcome> {
    const apiKey = process.env.YOUTUBE_API_KEY;
    if (!apiKey) return fail("platform_not_configured");

    const identifier = parseYouTubeIdentifier(declaredHandle);
    if (!identifier) return fail("external_account_not_found");

    let items: YouTubeChannel[];
    try {
      // channels.list is an exact lookup (id or handle) — never search.list.
      const resp = await axios.get(`${YOUTUBE_API_BASE}/channels`, {
        params: {
          part: "snippet,statistics",
          ...(identifier.kind === "channelId"
            ? { id: identifier.value }
            : { forHandle: `@${identifier.value}` }),
          key: apiKey,
        },
        timeout: 10000,
      });
      items = Array.isArray(resp.data?.items) ? resp.data.items : [];
    } catch (err) {
      return fail(this.classify(err));
    }

    // Exactly one channel, or nothing — never "the first of several".
    if (items.length !== 1) return fail("external_account_not_found");
    const channel = items[0];
    const channelId = text(channel.id);
    const customUrl = text(channel.snippet?.customUrl);
    if (!YT_CHANNEL_ID_RE.test(channelId)) return fail("platform_api_error");

    if (identifier.kind === "channelId" && channelId !== identifier.value) {
      return fail("account_mismatch");
    }
    // A handle lookup must come back with that same handle (case-insensitive).
    if (
      identifier.kind === "handle" &&
      customUrl.toLowerCase() !== `@${identifier.value.toLowerCase()}`
    ) {
      return fail("account_mismatch");
    }

    const hidden = channel.statistics?.hiddenSubscriberCount === true;
    return {
      ok: true,
      data: {
        source: "youtube",
        externalAccountId: channelId,
        observedHandle: customUrl.replace(/^@/, ""),
        observedFollowersCount: hidden
          ? null
          : finiteOrNull(channel.statistics?.subscriberCount),
        externalUrl: `https://www.youtube.com/channel/${channelId}`,
        rawPlatformUpdatedAt: null,
      },
    };
  }

  private classify(err: unknown): ObservationFailureReason {
    const e = err as {
      response?: {
        status?: number;
        data?: { error?: { errors?: Array<{ reason?: string }> } };
      };
    };
    const status = e?.response?.status ?? null;
    const reason = e?.response?.data?.error?.errors?.[0]?.reason ?? "";
    // Status + Google's reason code only: the request URL carries the API key.
    this.logger.warn(
      `YouTube observation failed (HTTP ${status ?? "?"} ${reason || "no reason"})`,
    );
    if (
      status === 429 ||
      ["quotaExceeded", "rateLimitExceeded", "userRateLimitExceeded"].includes(
        reason,
      )
    ) {
      return "rate_limited";
    }
    return "platform_api_error";
  }
}

// ── Meta (Instagram / Facebook) ────────────────────────────────────────────

const IG_HOSTS = /^((www|m)\.)?instagram\.com$/i;
const IG_USERNAME_RE = /^[a-z0-9._]{1,30}$/;
const FB_HOSTS = /^((www|m|web)\.)?(facebook|fb)\.com$/i;
const FB_USERNAME_RE = /^[a-z0-9.]{5,50}$/;
const FB_PAGE_ID_RE = /^\d{5,25}$/;

/** Declared Instagram handle → lowercase username, or null. */
export function normalizeInstagramHandle(raw: unknown): string | null {
  const value = text(raw);
  if (!value) return null;
  const url = parseUrlOn(value, IG_HOSTS);
  let candidate: string;
  if (url) {
    candidate = url.pathname.split("/").filter(Boolean)[0] || "";
  } else {
    if (/[/\s?#]/.test(value)) return null;
    candidate = value.startsWith("@") ? value.slice(1) : value;
  }
  const username = candidate.toLowerCase();
  return IG_USERNAME_RE.test(username) ? username : null;
}

/** Declared Facebook Page → lowercase Page username or numeric Page id, or null (never a display name). */
export function normalizeFacebookPageRef(raw: unknown): string | null {
  const value = text(raw);
  if (!value) return null;
  const url = parseUrlOn(value, FB_HOSTS);
  let candidate: string;
  if (url) {
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments[0] === "profile.php") {
      candidate = url.searchParams.get("id") || "";
    } else if (segments[0] === "pages") {
      candidate = segments[segments.length - 1] || "";
    } else {
      candidate = segments[0] || "";
    }
  } else {
    if (/[/\s?#]/.test(value)) return null;
    candidate = value.startsWith("@") ? value.slice(1) : value;
  }
  const ref = candidate.toLowerCase();
  return FB_PAGE_ID_RE.test(ref) || FB_USERNAME_RE.test(ref) ? ref : null;
}

interface MetaConnection {
  accessToken?: string;
  instagramBusinessAccountId?: string | null;
}

function classifyMeta(err: unknown): ObservationFailureReason {
  if (!(err instanceof MetaGraphError)) return "platform_api_error";
  // 190 = invalid/expired token; 10/200-299 = permission not granted.
  if (
    err.graphCode === 190 ||
    err.graphCode === 10 ||
    (err.graphCode !== null && err.graphCode >= 200 && err.graphCode < 300) ||
    err.httpStatus === 401
  ) {
    return "authorization_required";
  }
  if (
    [4, 17, 32, 613].includes(err.graphCode ?? -1) ||
    err.httpStatus === 429
  ) {
    return "rate_limited";
  }
  return "platform_api_error";
}

@Injectable()
export class MetaObserver {
  private readonly logger = new Logger(MetaObserver.name);

  constructor(
    @InjectModel("SocialOAuthConnection")
    private readonly connectionModel: Model<any>,
    private readonly metaOAuthService: MetaOAuthService,
  ) {}

  /**
   * Reuses the creator's existing Meta OAuth connection (token stays in
   * social_oauth_connections, select:false). The connection is per profile +
   * platform, so the observed account is only accepted when it is EXACTLY the
   * account declared on this socialAccountId.
   */
  async observe(
    platform: "instagram" | "facebook",
    profileType: SocialProfileType,
    profileId: string,
    declaredHandle: unknown,
  ): Promise<ObservationOutcome> {
    if (!this.metaOAuthService.isConfigured()) {
      return fail("platform_not_configured");
    }
    const declared =
      platform === "instagram"
        ? normalizeInstagramHandle(declaredHandle)
        : normalizeFacebookPageRef(declaredHandle);
    if (!declared) return fail("external_account_not_found");

    const connection = (await this.connectionModel
      .findOne({
        userId: profileId,
        userType: profileType,
        platform,
        revokedAt: null,
      })
      .select("+accessToken instagramBusinessAccountId")
      .lean()) as MetaConnection | null;
    if (!connection?.accessToken) return fail("authorization_required");

    try {
      return platform === "instagram"
        ? await this.observeInstagram(connection, declared)
        : await this.observeFacebook(connection.accessToken, declared);
    } catch (err) {
      const reason = classifyMeta(err);
      // MetaGraphError carries codes only — never the token.
      this.logger.warn(
        `Meta ${platform} observation failed: ${err instanceof MetaGraphError ? err.message : "unexpected error"}`,
      );
      return fail(reason);
    }
  }

  private async observeInstagram(
    connection: MetaConnection,
    declaredUsername: string,
  ): Promise<ObservationOutcome> {
    const igId = text(connection.instagramBusinessAccountId);
    if (!igId) return fail("authorization_required");
    const account = await this.metaOAuthService.fetchInstagramAccount(
      igId,
      String(connection.accessToken),
    );
    if (account.id !== igId || !account.username) {
      return fail("external_account_not_found");
    }
    if (account.username.toLowerCase() !== declaredUsername) {
      return fail("account_mismatch");
    }
    return {
      ok: true,
      data: {
        source: "instagram",
        externalAccountId: account.id,
        observedHandle: account.username,
        observedFollowersCount: finiteOrNull(account.followersCount),
        externalUrl: `https://www.instagram.com/${account.username}/`,
        rawPlatformUpdatedAt: null,
      },
    };
  }

  private async observeFacebook(
    accessToken: string,
    declaredRef: string,
  ): Promise<ObservationOutcome> {
    const pages = await this.metaOAuthService.fetchFacebookPages(accessToken);
    // The one Page whose id or unique username IS the declared reference —
    // never pages[0], never a display-name match.
    const matches = pages.filter(
      (p) => p.id === declaredRef || p.username?.toLowerCase() === declaredRef,
    );
    if (matches.length !== 1) return fail("account_mismatch");
    const page = matches[0];
    return {
      ok: true,
      data: {
        source: "facebook",
        externalAccountId: page.id,
        observedHandle: page.username || page.id,
        observedFollowersCount: finiteOrNull(page.followersCount),
        externalUrl:
          page.link && /^https:\/\/(www\.)?facebook\.com\//i.test(page.link)
            ? page.link
            : `https://www.facebook.com/${page.id}`,
        rawPlatformUpdatedAt: null,
      },
    };
  }
}
