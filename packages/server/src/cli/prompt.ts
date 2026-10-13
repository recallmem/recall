import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import type { CliIo } from "./common.js";

/** A question-asker for an interactive terminal; `secret` answers are not echoed. */
export function terminalPrompt(): NonNullable<CliIo["prompt"]> {
  return (question, opts = {}) =>
    new Promise((resolve) => {
      let muted = false;
      const output = new Writable({
        write(chunk, encoding, done) {
          if (!muted) process.stderr.write(chunk, encoding);
          done();
        },
      });
      const rl = createInterface({ input: process.stdin, output, terminal: true });
      rl.question(question, (answer) => {
        if (muted) process.stderr.write("\n");
        rl.close();
        resolve(answer.trim());
      });
      // The question itself has been written; hide what is typed after it.
      muted = opts.secret === true;
    });
}
