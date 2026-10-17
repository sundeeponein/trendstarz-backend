import * as fs from "fs";
import * as path from "path";

/**
 * Regression guard: ScheduleModule.forRoot() must be registered exactly once
 * (in AppModule). Each extra forRoot() starts every @Cron job again, so all
 * scheduled work — reminders, cleanups, payout sweeps — would run twice.
 */
describe("scheduler registration", () => {
  function sourceFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) return sourceFiles(full);
      return e.name.endsWith(".ts") && !e.name.endsWith(".spec.ts")
        ? [full]
        : [];
    });
  }

  it("calls ScheduleModule.forRoot() exactly once, in app.module.ts", () => {
    const hits = sourceFiles(__dirname).filter((f) =>
      /ScheduleModule\.forRoot\(/.test(fs.readFileSync(f, "utf8")),
    );
    expect(hits.map((f) => path.relative(__dirname, f))).toEqual([
      "app.module.ts",
    ]);
  });
});
