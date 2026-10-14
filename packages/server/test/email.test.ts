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

describe("email blocks", () => {
  const { html, text } = renderEmail("https://recallmem.dev", {
    preheader: "p",
    heading: "h",
    paragraphs: [
      "Create a key at https://app.recallmem.dev/keys. Then (see https://recallmem.dev/docs#quickstart) start.",
      { code: "npm install <pkg> && echo 'https://x.example/no-link'\nsecond line" },
    ],
    footnote: "Turn them off: https://app.recallmem.dev/unsubscribe?t=a&b",
  });

  it("links https addresses in paragraphs and the footnote, without the punctuation after them", () => {
    expect(html).toContain(
      'Create a key at <a href="https://app.recallmem.dev/keys" style="color:#ffb000;">https://app.recallmem.dev/keys</a>. Then (see <a href="https://recallmem.dev/docs#quickstart"',
    );
    expect(html).toContain("</a>) start.");
    expect(html).toContain('<a href="https://app.recallmem.dev/unsubscribe?t=a&#38;b"');
  });

  it("keeps code as escaped preformatted text, indented in the plain-text part", () => {
    expect(html).toMatch(
      /<pre[^>]*>npm install &#60;pkg&#62; &#38;&#38; echo &#39;https:\/\/x\.example\/no-link&#39;\nsecond line<\/pre>/,
    );
    expect(html).not.toContain('href="https://x.example');
    expect(text).toContain(
      "    npm install <pkg> && echo 'https://x.example/no-link'\n    second line",
    );
  });
});
