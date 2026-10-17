import { BadRequestException } from "@nestjs/common";
import { of } from "rxjs";
import {
  findOperatorKey,
  RejectOperatorKeysInterceptor,
} from "./reject-operator-keys.interceptor";

const ctx = (body: unknown, query: unknown = {}) =>
  ({ switchToHttp: () => ({ getRequest: () => ({ body, query }) }) }) as any;

describe("RejectOperatorKeysInterceptor", () => {
  const interceptor = new RejectOperatorKeysInterceptor();
  const next = { handle: () => of("ok") };

  it("finds operator keys at any depth, in objects and arrays", () => {
    expect(findOperatorKey({ email: { $ne: null } })).toBe("$ne");
    expect(findOperatorKey({ a: [{ b: { $gt: "" } }] })).toBe("$gt");
    expect(findOperatorKey({ name: "$5 offer", price: 100 })).toBeNull(); // $ in a VALUE is fine
    expect(findOperatorKey(Buffer.from('{"$x":1}'))).toBeNull(); // raw webhook bodies untouched
  });

  it("refuses a body or query with an operator key", () => {
    expect(() => interceptor.intercept(ctx({ email: { $ne: null } }), next)).toThrow(BadRequestException);
    expect(() => interceptor.intercept(ctx({}, { status: { $in: ["a"] } }), next)).toThrow(BadRequestException);
  });

  it("passes normal requests through", () => {
    expect(() => interceptor.intercept(ctx({ email: "a@b.com", tags: ["x"] }), next)).not.toThrow();
  });
});
