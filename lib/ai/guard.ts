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

// Claims about capacity or stock: whether something is free, left or full is
// what a sales person confirms, never the model. Written as the phrase, since
// "تکمیل فرم" (filling in the form) is an ordinary thing to say.
const AVAILABILITY_PHRASES = ["ظرفیت", "موجود", "خالی", "باقی مانده", "باقی‌مانده", "تکمیل شد", "تکمیل است", "پر است", "پر شد"];

// Numbers written as Persian words. The big ones (hundreds, thousand) are
// figures by themselves; the small ones are only held back next to money,
// because "دو روز" is an ordinary sentence.
const BIG_NUMBER_WORDS = new Set(["صد", "یکصد", "دویست", "سیصد", "چهارصد", "پانصد", "ششصد", "هفتصد", "هشتصد", "نهصد", "هزار"]);
const SMALL_NUMBER_WORDS = new Set([
  "صفر", "یک", "دو", "سه", "چهار", "پنج", "شش", "هفت", "هشت", "نه", "ده", "یازده", "دوازده", "سیزده", "چهارده", "پانزده",
  "شانزده", "هفده", "هجده", "نوزده", "بیست", "سی", "چهل", "پنجاه", "شصت", "هفتاد", "هشتاد", "نود",
]);

// A domain or short link written without http: "shop.ir/pay", "t.me/x", "wa.me/98...".
const DOMAIN_LIKE =
  /(?<![\w.-])(?:[a-z0-9-]+\.)+(?:ir|com|net|org|io|me|co|app|dev|info|xyz|ly|ai|shop|online|site|tv|biz|link)\b(?:\/[^\s)»"']*)?/gi;

const NUMBER = /\d[\d,٬،.٫]*/g;
const URL_LIKE = /(?:https?:\/\/|www\.)[^\s)»"']+/gi;

function digitsOnly(token: string): string {
  return token.replace(/[^\d]/g, "");
}

function normalise(text: string): string {
  return toAsciiDigits(text).normalize("NFKC").replace(/\u200c/g, " ");
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
 * more digits, shorter ones next to a money word, money words themselves,
 * amounts in words, capacity or stock claims, and links or bare domains. Empty when the answer is safe to send.
 */
export function unsupportedFacts(answer: string, allowed: string): string[] {
  const text = normalise(answer);
  const known = normalise(allowed);
  const knownFigures = figuresIn(known);
  const knownLower = known.toLowerCase();
  const problems: string[] = [];

  const words = (value: string) => value.split(/[\s.,;:!?،؛()«»"'/\-]+/).filter(Boolean);
  const tokens = words(text);
  const knownTokens = new Set(words(known));
  const isMoneyWord = (w: string) => MONEY_WORDS.includes(w) || BIG_NUMBER_WORDS.has(w);
  tokens.forEach((word, i) => {
    if (knownTokens.has(word)) return;
    if (BIG_NUMBER_WORDS.has(word)) problems.push(word);
    else if (SMALL_NUMBER_WORDS.has(word) && tokens.slice(Math.max(0, i - 2), i + 3).some(isMoneyWord)) problems.push(word);
  });

  for (const phrase of AVAILABILITY_PHRASES) {
    if (text.includes(phrase) && !known.includes(phrase)) problems.push(phrase);
  }

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
  for (const match of text.replace(URL_LIKE, " ").matchAll(DOMAIN_LIKE)) {
    const domain = trimUrl(match[0]);
    if (!knownLower.includes(domain)) problems.push(domain);
  }

  return [...new Set(problems)];
}
