import { trustProxyHops } from "./trust-proxy.util";

describe("trustProxyHops", () => {
  it("defaults to 1 (Railway's edge) and accepts small explicit values", () => {
    expect(trustProxyHops(undefined)).toBe(1);
    expect(trustProxyHops("")).toBe(1);
    expect(trustProxyHops("2")).toBe(2);
    expect(trustProxyHops("0")).toBe(0);
    expect(trustProxyHops("abc")).toBe(1);
    expect(trustProxyHops("99")).toBe(1); // nonsense → safe default
  });
});

describe("Express with trust proxy = 1 (one proxy in front)", () => {
  it("req.ip is the address the proxy saw; a client-forged X-Forwarded-For can't change it", async () => {
    const express = require("express");
    const request = require("supertest");
    const app = express();
    app.set("trust proxy", trustProxyHops(undefined));
    app.get("/ip", (req: any, res: any) => res.json({ ip: req.ip }));
    // The proxy appends the real client (203.0.113.7) after whatever the client sent.
    const res = await request(app).get("/ip").set("X-Forwarded-For", "1.2.3.4, 203.0.113.7");
    expect(res.body.ip).toBe("203.0.113.7");
  });
});
