import { describe, expect, it } from "vitest";
import { unsupportedFacts } from "../lib/ai/guard";

const knowledge = "بلیت ۱۵۰ هزار تومان است. نشانی: https://shop.example.ir/tickets . تلفن ۰۲۱۱۲۳۴۵۶۷۸";

describe("what the AI may state", () => {
  it("lets through figures, words and links that the knowledge base contains, in any digit script", () => {
    expect(unsupportedFacts("بلیت 150 هزار تومان است؛ از https://shop.example.ir/tickets بخرید.", knowledge)).toEqual([]);
    expect(unsupportedFacts("تلفن: 02112345678", knowledge)).toEqual([]);
  });

  it("matches a figure however the thousands are separated", () => {
    expect(unsupportedFacts("قیمت ۱,۵۰۰,۰۰۰ تومان", "بلیت ۱٬۵۰۰٬۰۰۰ تومان")).toEqual([]);
  });

  it("holds back a price that is not there", () => {
    expect(unsupportedFacts("بلیت ۲۰۰ هزار تومان است", knowledge)).toEqual(["200"]);
  });

  it("holds back a short figure when it sits next to money, but not a plain count", () => {
    expect(unsupportedFacts("تخفیف ۱۰ درصد", knowledge)).toEqual(expect.arrayContaining(["10"]));
    expect(unsupportedFacts("دو یا ۳ روز", knowledge)).toEqual([]);
  });

  it("holds back an amount written in words when no money word was given", () => {
    expect(unsupportedFacts("حدود پنج میلیارد", "ما مشاوره می‌دهیم")).toEqual(["میلیارد"]);
  });

  it("holds back a link that was never given", () => {
    expect(unsupportedFacts("ببینید: https://evil.example/pay.", knowledge)).toEqual(["https://evil.example/pay"]);
  });

  it("lets through a plain answer with nothing to check", () => {
    expect(unsupportedFacts("سلام، یکی از مشاوران ما با شما تماس می‌گیرد.", knowledge)).toEqual([]);
  });
});
