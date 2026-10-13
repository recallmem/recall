import { describe, expect, it } from "vitest";
import { renderEmail } from "../src/lib/email.js";

describe("email layout", () => {
  const { html, text } = renderEmail("https://recallmem.dev/", {
    preheader: "Your link <now>",
    heading: "Sign in to Recall",
    paragraphs: ["Hello & welcome"],
    button: { label: "Sign in", url: "https://app.recallmem.dev/auth/verify?token=a&b=<x>" },
    footnote: "Expires in 15 minutes.",
  });

  it("uses absolute image URLs, inline styles and escapes every value", () => {
    expect(html).toContain('src="https://recallmem.dev/email/header.png"');
    expect(html).not.toContain("<style");
    expect(html).not.toContain("<now>");
    expect(html).toContain("Hello &#38; welcome");
    expect(html).toContain("token=a&#38;b=&#60;x&#62;");
    expect(html).toContain("KvK 99124254");
  });

  it("has a plain-text part with the link", () => {
    expect(text).toContain("Sign in: https://app.recallmem.dev/auth/verify?token=a&b=<x>");
    expect(text).toContain("Expires in 15 minutes.");
  });
});
