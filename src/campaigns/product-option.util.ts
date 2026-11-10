/**
 * Product campaigns that ship: the host may ask the creator one thing when they
 * accept — "Shirt size (Men)", "Shoe size (UK)", "Fragrance" … — with optional
 * fixed choices. Empty question = nothing asked (e.g. electronics). 2026-11-10.
 *
 * The answer is stored in invite.shippingAddress (optionQuestion/optionAnswer)
 * so it follows the address's visibility and deletion rules.
 */

export const PRODUCT_OPTION_QUESTION_MAX = 60;
export const PRODUCT_OPTION_CHOICE_MAX = 30;
export const PRODUCT_OPTION_CHOICES_MAX = 15;
export const PRODUCT_OPTION_ANSWER_MAX = 60;

function clean(value: unknown, max: number): string {
  return String(value ?? "")
    // control characters and angle brackets never belong in a size/option
    .replace(/[\u0000-\u001f\u007f<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max)
    .trim();
}

/** Host input → stored question + choices (array or comma-separated text). */
export function normalizeProductOption(
  question: unknown,
  choices: unknown,
): { question: string; choices: string[] } {
  const q = clean(question, PRODUCT_OPTION_QUESTION_MAX);
  if (!q) return { question: "", choices: [] };
  const raw = Array.isArray(choices)
    ? choices
    : typeof choices === "string"
      ? choices.split(",")
      : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    const c = clean(item, PRODUCT_OPTION_CHOICE_MAX);
    const key = c.toLowerCase();
    if (!c || seen.has(key)) continue;
    seen.add(key);
    out.push(c);
    if (out.length >= PRODUCT_OPTION_CHOICES_MAX) break;
  }
  return { question: q, choices: out };
}

/**
 * The creator's answer checked against the campaign's question: required when a
 * question is asked; with choices it must be one of them (stored as the host
 * wrote it, e.g. "xl" → "XL").
 */
export function productOptionAnswer(
  question: unknown,
  choices: unknown,
  answer: unknown,
): { question: string; answer: string; error?: string } {
  const q = clean(question, PRODUCT_OPTION_QUESTION_MAX);
  if (!q) return { question: "", answer: "" };
  const a = clean(answer, PRODUCT_OPTION_ANSWER_MAX);
  if (!a) return { question: q, answer: "", error: q };
  const list = Array.isArray(choices) ? choices.map((c) => clean(c, PRODUCT_OPTION_CHOICE_MAX)).filter(Boolean) : [];
  if (list.length) {
    const match = list.find((c) => c.toLowerCase() === a.toLowerCase());
    if (!match) return { question: q, answer: "", error: `${q} (choose one of: ${list.join(", ")})` };
    return { question: q, answer: match };
  }
  return { question: q, answer: a };
}
