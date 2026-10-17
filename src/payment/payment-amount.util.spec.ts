import { paymentAmountPaise, paymentAmountRupees } from "./payment-amount.util";

describe("paymentAmountPaise", () => {
  it("prefers the explicit amountPaise field", () => {
    expect(paymentAmountPaise({ amount: 499, amountPaise: 49900 })).toBe(49900);
  });

  it("reads legacy Razorpay rows as paise", () => {
    expect(
      paymentAmountPaise({ amount: 49900, gatewayProvider: "razorpay" }),
    ).toBe(49900);
    expect(
      paymentAmountPaise({ amount: 49900, paymentMethod: "razorpay" }),
    ).toBe(49900);
  });

  it("reads legacy manual UPI rows as rupees", () => {
    expect(paymentAmountPaise({ amount: 499, paymentMethod: "upi" })).toBe(
      49900,
    );
    expect(
      paymentAmountRupees({ amount: 499, gatewayProvider: "manual_upi" }),
    ).toBe(499);
  });

  it("treats missing or bad amounts as 0", () => {
    expect(paymentAmountPaise({})).toBe(0);
    expect(paymentAmountPaise({ amount: "x" })).toBe(0);
  });
});
