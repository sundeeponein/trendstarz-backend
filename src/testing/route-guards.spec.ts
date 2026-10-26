import * as fs from "fs";
import * as path from "path";

/**
 * Every endpoint's guards, checked from the source (all *.controller.ts):
 *  1. An endpoint that reads the logged-in user (req.user) must carry JwtAuthGuard —
 *     2026-10-26 an inserted route split the guard from getProfileVisibility and every
 *     login was refused with "You can only view your own settings".
 *  2. An endpoint under an "admin" path must carry RolesGuard (admin/subadmin only).
 * Exceptions are listed below with the reason; a new one must be added on purpose.
 */
const ADMIN_PATH_EXCEPTIONS: Record<string, string> = {
  "auth/admin-login/verify": "the admin sign-in code step itself: runs before there is a session",
  "users/influencer-profile/admin-social-notifications/dismiss": "a user dismisses notes an admin left them",
  "users/photographers/me/admin-social-notifications/dismiss": "a user dismisses notes an admin left them",
  "campaign-invites/:id/request-admin-review": "a user asks an admin to review",
};

const ROUTE = /^\s*@(Get|Post|Put|Patch|Delete)\((?:"([^"]*)"|'([^']*)')?/;
const METHOD = /^\s*(?:async\s+)?\w+\s*\(/;

function controllerFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return controllerFiles(full);
    return e.name.endsWith(".controller.ts") ? [full] : [];
  });
}

interface Route { file: string; line: number; path: string; guards: string; body: string }

function routes(): Route[] {
  const out: Route[] = [];
  for (const file of controllerFiles(path.join(__dirname, ".."))) {
    const src = fs.readFileSync(file, "utf8");
    const lines = src.split("\n");
    const cls = src.match(/((?:\s*@\w+\([^\n]*\)\s*\n)*)\s*export class/);
    const classDecorators = cls ? cls[1] : "";
    const base = (classDecorators.match(/@Controller\(["']([^"']*)/) || [])[1] || "";
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(ROUTE);
      if (!m) continue;
      let start = i;
      while (start > 0 && lines[start - 1].trim().startsWith("@")) start--;
      let sig = i;
      while (sig < lines.length && !METHOD.test(lines[sig])) sig++;
      let end = sig + 1;
      while (end < lines.length && !ROUTE.test(lines[end]) && !lines[end].startsWith("}")) end++;
      const sub = m[2] ?? m[3] ?? "";
      out.push({
        file: path.relative(path.join(__dirname, ".."), file),
        line: i + 1,
        path: [base, sub].filter(Boolean).join("/"),
        guards: classDecorators + "\n" + lines.slice(start, sig).join("\n"),
        body: lines.slice(sig, end).join("\n"),
      });
      i = sig;
    }
  }
  return out;
}

describe("route guards (all controllers)", () => {
  const all = routes();

  it("finds the routes", () => {
    expect(all.length).toBeGreaterThan(200);
  });

  it("every endpoint that reads the logged-in user has the login guard", () => {
    const missing = all
      .filter((r) => /\breq(?:uest)?\??\.user\b|\(req as any\)\??\.user/.test(r.body))
      .filter((r) => !/JwtAuthGuard/.test(r.guards))
      .map((r) => `${r.file}:${r.line} ${r.path}`);
    expect(missing).toEqual([]);
  });

  it("every admin endpoint has the admin role guard", () => {
    const missing = all
      .filter((r) => /(^|\/)admin(\/|-|$)/i.test(r.path) && !ADMIN_PATH_EXCEPTIONS[r.path])
      .filter((r) => !/RolesGuard/.test(r.guards))
      .map((r) => `${r.file}:${r.line} ${r.path}`);
    expect(missing).toEqual([]);
  });
});
