import { scheduledJobsEnabled, SingleInstance } from "./single-instance";

describe("scheduled jobs run only on the production deploy", () => {
  it("is off on a laptop, on in production / Railway / tests, and CRON_ENABLED overrides", () => {
    expect(scheduledJobsEnabled({} as any)).toBe(false); // local .env: no NODE_ENV, no Railway
    expect(scheduledJobsEnabled({ NODE_ENV: "development" } as any)).toBe(false);
    expect(scheduledJobsEnabled({ NODE_ENV: "production" } as any)).toBe(true);
    expect(scheduledJobsEnabled({ RAILWAY_ENVIRONMENT_NAME: "production" } as any)).toBe(true);
    expect(scheduledJobsEnabled({ RAILWAY_ENVIRONMENT: "production" } as any)).toBe(true);
    expect(scheduledJobsEnabled({ NODE_ENV: "test" } as any)).toBe(true);
    expect(scheduledJobsEnabled({ CRON_ENABLED: "true" } as any)).toBe(true);
    expect(scheduledJobsEnabled({ NODE_ENV: "production", CRON_ENABLED: "false" } as any)).toBe(false);
  });

  it("a job does nothing when jobs are off", async () => {
    const saved = { ...process.env };
    process.env.NODE_ENV = "development";
    delete process.env.CRON_ENABLED;
    delete process.env.RAILWAY_ENVIRONMENT;
    delete process.env.RAILWAY_ENVIRONMENT_NAME;
    delete process.env.RAILWAY_ENVIRONMENT_ID;
    const ran = jest.fn(async () => "ran");
    class Jobs {
      @SingleInstance()
      async nightly() {
        return ran();
      }
    }
    try {
      await expect(new Jobs().nightly()).resolves.toBeUndefined();
      expect(ran).not.toHaveBeenCalled();
    } finally {
      process.env = saved;
    }
  });
});
