/** How many proxy hops sit in front of the app (Express "trust proxy"); default 1. */
export function trustProxyHops(raw: unknown): number {
  const n = Number.parseInt(String(raw ?? ""), 10);
  return Number.isFinite(n) && n >= 0 && n <= 5 ? n : 1;
}
