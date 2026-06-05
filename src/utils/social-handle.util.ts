import { BadRequestException } from "@nestjs/common";

export function normalizeSocialHandle(value: unknown, platformName = ""): string {
  let text = String(value || "").trim();
  if (!text) return "";

  text = text.replace(/^@+/, "");

  try {
    const withProtocol = /^https?:\/\//i.test(text) ? text : `https://${text}`;
    const url = new URL(withProtocol);
    if (url.hostname.includes(".")) {
      text = `${url.pathname}${url.search}`;
    }
  } catch {
    // Keep direct usernames as-is and continue with cleanup.
  }

  text = text.split("?")[0].split("#")[0];
  text = text.replace(/^\/+|\/+$/g, "");

  const platform = String(platformName || "").toLowerCase();
  if (platform.includes("youtube")) {
    text = text.replace(/^channel\//i, "").replace(/^c\//i, "").replace(/^user\//i, "");
  }
  if (platform.includes("linkedin")) {
    text = text.replace(/^in\//i, "").replace(/^company\//i, "");
  }

  return text.replace(/@/g, "").replace(/\s+/g, "");
}

export function socialHandleAllowedPattern(platformName = ""): RegExp {
  const platform = String(platformName || "").toLowerCase();
  if (platform.includes("youtube")) return /^[a-zA-Z0-9._@-]+$/;
  if (platform.includes("linkedin")) return /^[a-zA-Z0-9-]+$/;
  if (platform.includes("twitter") || platform === "x") return /^[a-zA-Z0-9_]+$/;
  if (platform.includes("instagram") || platform.includes("facebook")) return /^[a-zA-Z0-9._]+$/;
  return /^[a-zA-Z0-9._-]+$/;
}

export function socialHandleAllowedCharacters(platformName = ""): string {
  const platform = String(platformName || "").toLowerCase();
  if (platform.includes("youtube")) return "letters, numbers, dot (.), underscore (_), hyphen (-), and @";
  if (platform.includes("linkedin")) return "letters, numbers, and hyphen (-)";
  if (platform.includes("twitter") || platform === "x") return "letters, numbers, and underscore (_)";
  if (platform.includes("instagram") || platform.includes("facebook")) return "letters, numbers, dot (.), and underscore (_)";
  return "letters, numbers, dot (.), underscore (_), and hyphen (-)";
}

export function validateSocialHandle(value: unknown, platformName = ""): string | null {
  const clean = normalizeSocialHandle(value, platformName);
  if (!clean) return "Username is required.";
  if (!socialHandleAllowedPattern(platformName).test(clean)) {
    return `${platformName || "Social"} username can only contain ${socialHandleAllowedCharacters(platformName)}.`;
  }
  return null;
}

export function normalizeSocialMediaList(value: unknown): any[] {
  if (!Array.isArray(value)) return [];
  return value.map((item: any) => {
    const platform = item?.platform || item?.name || "";
    const contentTypes = Array.isArray(item?.contentTypes)
      ? item.contentTypes
          .filter((ct: any) => {
            const price = Number(ct?.price);
            const selected = ct?.enabled === true || ct?.selected === true;
            return selected && Number.isFinite(price) && price > 0;
          })
          .map((ct: any) => ({
            name: String(ct?.name || ct?.label || "").trim(),
            enabled: true,
            price: Number(ct.price),
          }))
          .filter((ct: any) => !!ct.name)
      : [];
    const handle = normalizeSocialHandle(item?.handle, platform);
    const handleError = validateSocialHandle(handle, platform);
    if (handleError) throw new BadRequestException(handleError);
    return {
      ...item,
      handle,
      contentTypes,
    };
  });
}
