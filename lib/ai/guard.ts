import { toAsciiDigits } from "@/lib/forms/answers";

/**
 * A check on what the model wrote, before a customer sees it. The system
 * prompt asks it never to invent prices, dates or links, but a prompt is a
 * request, not a guarantee. For a business that quotes real estate or
 * billboard prices, a made-up figure is worse than a slow answer, so any
 * figure, price word or link in the answer must already appear in what the
 * assistant was given: the persona, the knowledge base, or the conversation.
 */

// Words that mark a sum of money; one the answer uses but nothing it was
// given contains means a price came from nowhere.
const MONEY_WORDS = ["تومان", "تومن", "ریال", "میلیون", "میلیارد", "دلار", "یورو", "درهم", "درصد", "تخفیف"];
const MONEY_SYMBOLS = /[$€£%]/;

const NUMBER = /\d[\d,٬،.٫]*/g;
const URL_LIKE = /(?:https?:\/\/|www\.)[^\s)»"']+/gi;

function digitsOnly(token: string): string {
  return token.replace(/[^\d]/g, "");
}

function normalise(text: string): string {
  return toAsciiDigits(text).normalize("NFKC");
}

/** Digit groups of a text, without separators: "1,500,000" and "۱۵۰۰۰۰۰" are one. */
function figuresIn(text: string): Set<string> {
  const found = new Set<string>();
  for (const match of normalise(text).matchAll(NUMBER)) {
    const digits = digitsOnly(match[0]);
    if (digits) found.add(digits);
  }
  return found;
}

function trimUrl(url: string): string {
  return url.replace(/[.,;:!?،؛]+$/, "").toLowerCase();
}

/**
 * What the answer says that nothing it was given supports: figures of three or
 * more digits, shorter ones next to a money word, money words themselves, and
 * links. Empty when the answer is safe to send.
 */
export function unsupportedFacts(answer: string, allowed: string): string[] {
  const text = normalise(answer);
  const known = normalise(allowed);
  const knownFigures = figuresIn(known);
  const knownLower = known.toLowerCase();
  const problems: string[] = [];

  for (const match of text.matchAll(NUMBER)) {
    const digits = digitsOnly(match[0]);
    if (!digits || knownFigures.has(digits)) continue;
    const start = Math.max(0, (match.index ?? 0) - 12);
    const around = text.slice(start, (match.index ?? 0) + match[0].length + 12);
    const nearMoney = MONEY_SYMBOLS.test(around) || MONEY_WORDS.some((w) => around.includes(w));
    if (digits.length >= 3 || nearMoney) problems.push(match[0].replace(/[.,٬،٫]+$/, ""));
  }

  for (const word of MONEY_WORDS) {
    if (text.includes(word) && !knownLower.includes(word)) problems.push(word);
  }

  for (const match of text.matchAll(URL_LIKE)) {
    const url = trimUrl(match[0]);
    if (!knownLower.includes(url)) problems.push(url);
  }

  return [...new Set(problems)];
}
