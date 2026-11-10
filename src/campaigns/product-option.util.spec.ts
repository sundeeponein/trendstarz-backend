import { normalizeProductOption, productOptionAnswer } from "./product-option.util";

describe("product option (size etc.)", () => {
  it("no question means nothing is asked, and choices are dropped", () => {
    expect(normalizeProductOption("  ", "S, M")).toEqual({ question: "", choices: [] });
    expect(productOptionAnswer("", ["S"], "")).toEqual({ question: "", answer: "" });
  });

  it("cleans the question and splits/dedupes comma-separated choices", () => {
    const r = normalizeProductOption(" Shirt  size <b>(Men)</b> ", "S, m , M,, XL ,XXL");
    expect(r.question).toBe("Shirt size b (Men) /b");
    expect(r.choices).toEqual(["S", "m", "XL", "XXL"]);
    expect(normalizeProductOption("Q", Array.from({ length: 30 }, (_, i) => `UK ${i}`)).choices).toHaveLength(15);
    expect(normalizeProductOption("x".repeat(100), []).question).toHaveLength(60);
  });

  it("an answer is required; with choices it must be one of them (stored as written)", () => {
    expect(productOptionAnswer("Shirt size", ["S", "XL"], "").error).toBe("Shirt size");
    expect(productOptionAnswer("Shirt size", ["S", "XL"], "xl")).toEqual({ question: "Shirt size", answer: "XL" });
    expect(productOptionAnswer("Shirt size", ["S", "XL"], "XXXL").error).toMatch(/choose one of: S, XL/);
    expect(productOptionAnswer("Fragrance", [], "  Woody  ")).toEqual({ question: "Fragrance", answer: "Woody" });
  });
});
