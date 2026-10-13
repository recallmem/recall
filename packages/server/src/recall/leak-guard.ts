/**
 * Stops an answer that starts reproducing the chat instructions. A question can ask the model
 * to print its prompt; the rules tell it not to, and this guard catches it when it does anyway:
 * any run of RUN consecutive words that also occurs in the instructions ends the answer.
 * Streaming-safe: words that could be the start of such a run are held back until the run
 * breaks off, so none of a matching run is ever sent.
 */

/** Consecutive words that count as a reproduction. Long enough that ordinary answers never match. */
const RUN = 8;

export const WITHHELD_ANSWER =
  "I can't share that. Ask me about the people and conversations I remember.";

const WORD = /[\p{L}\p{N}]+/gu;

function words(text: string): string[] {
  return (text.toLowerCase().match(WORD) ?? []) as string[];
}

/** Every RUN-word sequence of the instructions, and every shorter prefix of one. */
export class Instructions {
  readonly runs = new Set<string>();
  readonly prefixes = new Set<string>();

  constructor(texts: string[]) {
    for (const text of texts) {
      const w = words(text);
      for (let i = 0; i + RUN <= w.length; i++) {
        this.runs.add(w.slice(i, i + RUN).join(" "));
        for (let k = 1; k < RUN; k++) this.prefixes.add(w.slice(i, i + k).join(" "));
      }
    }
  }

  /** Whole-text check for answers that are not streamed. */
  reproducedIn(text: string): boolean {
    const w = words(text);
    for (let i = 0; i + RUN <= w.length; i++)
      if (this.runs.has(w.slice(i, i + RUN).join(" "))) return true;
    return false;
  }
}

interface Word {
  norm: string;
  start: number;
}

export class LeakGuard {
  private text = "";
  /** Where the scan for complete words resumes, and how much text has been released. */
  private scanned = 0;
  private released = 0;
  /** The last RUN - 1 complete words. */
  private recent: Word[] = [];
  tripped = false;

  constructor(private readonly instructions: Instructions) {}

  /** Feeds a chunk; returns the text that is safe to send now ("" once tripped). */
  push(chunk: string): string {
    if (this.tripped) return "";
    this.text += chunk;
    if (this.scan(false)) return "";
    return this.release(this.holdFrom());
  }

  /** Releases the rest at the end of the stream, unless the answer reproduced the instructions. */
  flush(): string {
    if (this.tripped || this.scan(true)) return "";
    return this.release(this.text.length);
  }

  /** Reads the newly completed words; true (and tripped) once they end a copied run. */
  private scan(final: boolean): boolean {
    WORD.lastIndex = this.scanned;
    for (let m = WORD.exec(this.text); m; m = WORD.exec(this.text)) {
      const end = m.index + m[0].length;
      // A word touching the end of the text may still grow with the next chunk.
      if (end === this.text.length && !final) break;
      this.scanned = end;
      this.recent.push({ norm: m[0].toLowerCase(), start: m.index });
      if (this.recent.length === RUN) {
        if (this.instructions.runs.has(this.join(0))) this.tripped = true;
        this.recent.shift();
      }
      if (this.tripped) return true;
    }
    return false;
  }

  private join(from: number): string {
    return this.recent
      .slice(from)
      .map((w) => w.norm)
      .join(" ");
  }

  /** Start of the longest recent run that could still grow into a reproduction, or of the unfinished word. */
  private holdFrom(): number {
    for (let i = 0; i < this.recent.length; i++) {
      if (this.instructions.prefixes.has(this.join(i)))
        return this.recent[i]?.start ?? this.scanned;
    }
    WORD.lastIndex = this.scanned;
    const partial = WORD.exec(this.text);
    return partial ? partial.index : this.text.length;
  }

  private release(upTo: number): string {
    if (upTo <= this.released) return "";
    const out = this.text.slice(this.released, upTo);
    this.released = upTo;
    return out;
  }
}
