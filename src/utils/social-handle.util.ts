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

export function normalizeSocialMediaList(value: unknown): any[] {
  if (!Array.isArray(value)) return [];
  return value.map((item: any) => {
    const platform = item?.platform || item?.name || "";
    return {
      ...item,
      handle: normalizeSocialHandle(item?.handle, platform),
    };
  });
}
