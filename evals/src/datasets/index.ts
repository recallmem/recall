import { beamPath, dataPath } from "../download.js";
import type { DatasetName } from "../sources.js";
import type { SelectOptions, UnitSource } from "../types.js";
import { planBeam } from "./beam.js";
import { planLocomo } from "./locomo.js";
import { planLongMemEval } from "./longmemeval.js";

/** Reads `evals/data/<file>` (see `pnpm --filter @recall-memory/evals download`) and selects units. */
export async function planDataset(
  dataset: DatasetName,
  opts: SelectOptions,
  path?: string,
): Promise<UnitSource[]> {
  let file = path;
  try {
    if (dataset === "beam") {
      if (!opts.beamSplit) throw new Error("--beam-split is required for --dataset beam");
      file ??= beamPath(opts.beamSplit);
      return await planBeam(file, opts.beamSplit, opts);
    }
    file ??= dataPath(dataset);
    return dataset === "longmemeval"
      ? await planLongMemEval(file, opts)
      : await planLocomo(file, opts);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `dataset file not found: ${file}\nrun: pnpm --filter @recall-memory/evals download${dataset === "beam" ? ` --dataset beam --beam-split ${opts.beamSplit}` : ""}`,
      );
    }
    throw err;
  }
}
