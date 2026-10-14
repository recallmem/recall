import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { extractFileText, PDF_LIMITS } from "../src/core/files.js";
import { pdfInflation } from "../src/core/pdf-guard.js";

/**
 * The pre-read check on uploaded PDFs: a small file whose streams inflate to gigabytes is
 * refused before pdf.js reads it (pdf.js keeps decoded streams outside the worker's heap limit).
 */

const MB = 1024 * 1024;

/** A one-object-per-stream PDF body; good enough for the scanner, which does not need an xref. */
function pdf(...objects: (string | Buffer)[]): Buffer {
  const parts: Buffer[] = [Buffer.from("%PDF-1.4\n")];
  objects.forEach((o, i) => {
    parts.push(Buffer.from(`${i + 1} 0 obj\n`), Buffer.isBuffer(o) ? o : Buffer.from(o));
    parts.push(Buffer.from("\nendobj\n"));
  });
  parts.push(Buffer.from("%%EOF\n"));
  return Buffer.concat(parts);
}

function stream(dict: string, data: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`<< ${dict} >>\nstream\n`), data, Buffer.from("\nendstream")]);
}

const spaces = (n: number) => Buffer.alloc(n, 0x20);

describe("pdfInflation", () => {
  it("measures ordinary compressed streams and lets them through", () => {
    const z = deflateSync(Buffer.from("BT /F1 12 Tf (hello) Tj ET"));
    const r = pdfInflation(pdf(stream(`/Length ${z.length} /Filter /FlateDecode`, z)), MB);
    expect(r).toEqual({ ok: true, bytes: 26 });
  });

  it("refuses a stream that inflates past the budget", () => {
    const z = deflateSync(spaces(5 * MB));
    expect(z.length).toBeLessThan(10_000);
    expect(pdfInflation(pdf(stream(`/Length ${z.length} /Filter /FlateDecode`, z)), MB)).toEqual({
      ok: false,
      reason: "too_large",
    });
  });

  it("adds up many streams that are each under the budget", () => {
    const z = deflateSync(spaces(MB / 2));
    const objs = Array.from({ length: 3 }, () =>
      stream(`/Length ${z.length} /Filter /FlateDecode`, z),
    );
    expect(pdfInflation(pdf(...objs), MB).ok).toBe(false);
  });

  it("sees through hex and ASCII85 layers, double compression and an indirect filter", () => {
    const bomb = deflateSync(spaces(5 * MB));
    const hex = Buffer.from(`${bomb.toString("hex")}>`);
    expect(
      pdfInflation(
        pdf(stream(`/Length ${hex.length} /Filter [/ASCIIHexDecode /FlateDecode]`, hex)),
        MB,
      ).ok,
    ).toBe(false);
    const twice = deflateSync(bomb);
    expect(
      pdfInflation(
        pdf(stream(`/Length ${twice.length} /Filter [/FlateDecode /FlateDecode]`, twice)),
        MB,
      ).ok,
    ).toBe(false);
    expect(pdfInflation(pdf(stream(`/Length ${bomb.length} /Filter 9 0 R`, bomb)), MB).ok).toBe(
      false,
    );
  });

  it("reads a stream to its /Length, direct or an indirect reference", () => {
    const bomb = deflateSync(spaces(5 * MB));
    const direct = pdf(stream(`/Length ${bomb.length} /Filter /FlateDecode`, bomb));
    expect(pdfInflation(direct, MB).ok).toBe(false);
    const indirect = pdf(stream("/Length 2 0 R /Filter /FlateDecode", bomb), String(bomb.length));
    expect(pdfInflation(indirect, MB).ok).toBe(false);
  });

  it("skips images, which text extraction never decodes, and refuses LZW", () => {
    const big = deflateSync(spaces(5 * MB));
    expect(
      pdfInflation(
        pdf(stream(`/Subtype /Image /Length ${big.length} /Filter /FlateDecode`, big)),
        MB,
      ),
    ).toEqual({ ok: true, bytes: 0 });
    expect(
      pdfInflation(pdf(stream("/Length 3 /Filter /LZWDecode", Buffer.from("abc"))), MB),
    ).toEqual({
      ok: false,
      reason: "lzw",
    });
  });
});

describe("PDF upload", () => {
  it("answers 413 for a file that decompresses past the limit, without reading it", async () => {
    const z = deflateSync(spaces(PDF_LIMITS.maxInflatedBytes + MB));
    const file = pdf(stream(`/Length ${z.length} /Filter /FlateDecode`, z));
    expect(file.length).toBeLessThan(MB);
    await expect(extractFileText(file, "application/pdf")).rejects.toMatchObject({ status: 413 });
  });
});
