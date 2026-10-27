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
    expect(unsupportedFacts("حدود پنج میلیارد", "ما مشاوره می‌دهیم")).toEqual(expect.arrayContaining(["میلیارد"]));
  });

  it("holds back a link that was never given", () => {
    expect(unsupportedFacts("ببینید: https://evil.example/pay.", knowledge)).toEqual(["https://evil.example/pay"]);
  });

  it("lets through a plain answer with nothing to check", () => {
    expect(unsupportedFacts("سلام، یکی از مشاوران ما با شما تماس می‌گیرد.", knowledge)).toEqual([]);
  });
});

describe("what the guard now also holds back", () => {
  const kb = "ما در مشهد بیلبورد داریم. برای قیمت با مشاور صحبت کنید.";

  it("an amount spelled in Persian words", () => {
    expect(unsupportedFacts("قیمت حدود پانصد میلیون است", kb).length).toBeGreaterThan(0);
    expect(unsupportedFacts("هر ماه دو میلیون و نیم", kb).length).toBeGreaterThan(0);
    expect(unsupportedFacts("حدود دویست هزار", kb).length).toBeGreaterThan(0);
    expect(unsupportedFacts("سی درصد تخفیف", kb).length).toBeGreaterThan(0);
  });

  it("a word number is fine when the knowledge base already says it", () => {
    expect(unsupportedFacts("قیمت پانصد میلیون است", "قیمت پانصد میلیون تومان")).toEqual([]);
  });

  it("an ordinary small count in words is not held back", () => {
    expect(unsupportedFacts("یکی از مشاوران با شما تماس می‌گیرد. دو روز کاری طول می‌کشد.", kb)).toEqual([]);
  });

  it("availability and capacity claims", () => {
    for (const claim of ["این بیلبورد موجود است", "ظرفیت باقی مانده داریم", "هنوز خالی است", "ظرفیت تکمیل شد", "موجودی کافی است"]) {
      expect(unsupportedFacts(claim, kb), claim).not.toEqual([]);
    }
  });

  it("availability words stay allowed when the knowledge base uses them", () => {
    expect(unsupportedFacts("موجودی را مشاور اعلام می‌کند", "موجودی را مشاور اعلام می‌کند")).toEqual([]);
  });

  it("domains and handles written without http", () => {
    for (const link of ["مشاهده کنید: example.com/pay", "سایت: shop.ir", "کانال t.me/fake_channel", "wa.me/989121234567", "www.evil.net"]) {
      expect(unsupportedFacts(link, kb), link).not.toEqual([]);
    }
    expect(unsupportedFacts("سایت ما mariatamlik.ir است", "سایت ما mariatamlik.ir است")).toEqual([]);
  });
});
