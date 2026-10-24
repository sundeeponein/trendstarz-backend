import { publicEscrowRupees } from "./users.service";

describe("public Creator Escrow stat", () => {
  it("is in rupees (rows store paise) and hidden until it reaches ₹1,00,000", () => {
    expect(publicEscrowRupees(1360600)).toBeUndefined(); // ₹13,606 today: stays private
    expect(publicEscrowRupees(10000000)).toBe(100000); // ₹1,00,000 shows as 1,00,000 rupees
    expect(publicEscrowRupees(0)).toBeUndefined();
  });
});
