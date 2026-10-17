/**
 * Shared branded HTML email layout.
 *
 * Usage:
 *   import { wrapEmail, btn, p, h2 } from '../email/layout';
 *   const html = wrapEmail(`${h2('Hello!')}${p('Your content here.')}${btn('Click me', url)}`);
 */

// ─── Brand colours ────────────────────────────────────────────────────────────
export const BRAND_BLUE = "#0d6efd";
export const BRAND_PURPLE = "#6c63ff";
export const TEXT_MAIN = "#1f2937";
export const TEXT_MUTED = "#6b7280";
export const TEXT_LIGHT = "#9ca3af";
export const BG_PAGE = "#f5f7fb";
export const BG_CARD = "#ffffff";
export const BG_FOOTER = "#f9fafb";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Heading inside an email card */
export function h2(text: string): string {
  return `<h2 style="margin:0 0 12px 0;font-size:20px;color:${TEXT_MAIN};">${text}</h2>`;
}

/** Standard paragraph */
export function p(text: string, style = ""): string {
  return `<p style="margin:0 0 12px 0;line-height:1.5;${style}">${text}</p>`;
}

/** Key-value info row (e.g. "UTR: ABC123") */
export function kv(label: string, value: string): string {
  return `<p style="margin:6px 0;"><strong>${label}:</strong> ${value}</p>`;
}

/** Primary call-to-action button */
export function btn(label: string, url: string, colour = BRAND_BLUE): string {
  return `<p style="margin:20px 0;">
    <a href="${url}" style="display:inline-block;background:${colour};color:#ffffff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:600;">${label}</a>
  </p>`;
}

/** Dimmed text fallback link line */
export function fallbackLink(url: string): string {
  return `<p style="margin:8px 0;font-size:13px;color:${TEXT_MUTED};">Or copy this link: <a href="${url}" style="color:${BRAND_BLUE};">${url}</a></p>`;
}

// ─── Main wrapper ─────────────────────────────────────────────────────────────

/**
 * Wraps `bodyContent` (raw HTML string) inside the full branded email shell.
 *
 * @param bodyContent   Inner card HTML (use helpers above or plain HTML strings)
 * @param footerText    Optional override for the footer line
 */
export function wrapEmail(
  bodyContent: string,
  footerText = '— TrendStarz · <a href="https://trendstarz.in" style="color:#9ca3af;text-decoration:none;">trendstarz.in</a>',
): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:${BG_PAGE};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:${TEXT_MAIN};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0"
             style="background:${BG_CARD};border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,0.06);overflow:hidden;max-width:100%;">
        <!-- Header -->
        <tr>
          <td style="background:${BRAND_BLUE};padding:18px 24px;color:#ffffff;font-size:18px;font-weight:600;">
            TrendStarz
          </td>
        </tr>
        <!-- Body -->
        <tr>
          <td style="padding:28px 24px;">
            ${bodyContent}
          </td>
        </tr>
        <!-- Footer -->
        <tr>
          <td style="padding:14px 24px;background:${BG_FOOTER};color:${TEXT_LIGHT};font-size:12px;text-align:center;">
            ${footerText}
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// ─── Type ─────────────────────────────────────────────────────────────────────

export interface EmailTemplate {
  subject: string;
  html: string;
  text: string;
}
