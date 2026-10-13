/**
 * Where the benchmark datasets come from. All are public; the download script
 * fetches them into `evals/data/` (gitignored). Nothing here is redistributed.
 */
export interface DatasetSource {
  /** File name under evals/data/. */
  file: string;
  url: string;
  /** Approximate size, only used for the progress message and a sanity check. */
  approxBytes: number;
  /** Where the data and its license/terms live. */
  homepage: string;
}

/** Datasets that are a single file at a URL. */
export const SOURCES = {
  longmemeval: {
    // The "cleaned" release fixes the noisy sessions in the original files; this is
    // the version most recent memory-system papers evaluate on. 500 questions, ~115k tokens each.
    file: "longmemeval_s_cleaned.json",
    url: "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json",
    approxBytes: 277_000_000,
    homepage: "https://github.com/xiaowu0162/LongMemEval",
  },
  locomo: {
    // 10 long conversations, 1,986 questions in 5 categories.
    file: "locomo10.json",
    url: "https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json",
    approxBytes: 2_800_000,
    homepage: "https://github.com/snap-research/locomo",
  },
} as const satisfies Record<string, DatasetSource>;

export type FileDatasetName = keyof typeof SOURCES;

/**
 * BEAM ("Beyond a Million Tokens", Tavakoli et al. 2025, arXiv:2510.27246): 100 synthetic
 * user-assistant conversations at four lengths, 20 probing questions each (2 per memory ability).
 * The data is published on Hugging Face as parquet; `download` fetches it row by row from the
 * Hugging Face datasets-server JSON API and stores one JSON array per split (see download.ts).
 *
 * License of the data: CC BY-SA 4.0 (dataset cards of both repos). The paper is CC BY 4.0.
 */
export const BEAM_SPLITS = ["100k", "500k", "1m", "10m"] as const;
export type BeamSplit = (typeof BEAM_SPLITS)[number];

export interface BeamSource {
  file: string;
  /** Hugging Face dataset repo and split name. */
  repo: string;
  split: string;
  conversations: number;
  /** Approximate size of the JSON file, for sanity checks and progress messages. */
  approxBytes: number;
  /** Whether the datasets-server can serve rows of this split (BEAM-10M rows are ~900 MB each). */
  viewer: boolean;
}

export const BEAM_SOURCES: Record<BeamSplit, BeamSource> = {
  "100k": {
    file: "beam-100k.json",
    repo: "Mohammadta/BEAM",
    split: "100K",
    conversations: 20,
    approxBytes: 13_500_000,
    viewer: true,
  },
  "500k": {
    file: "beam-500k.json",
    repo: "Mohammadta/BEAM",
    split: "500K",
    conversations: 35,
    approxBytes: 84_000_000,
    viewer: true,
  },
  "1m": {
    file: "beam-1m.json",
    repo: "Mohammadta/BEAM",
    split: "1M",
    conversations: 35,
    approxBytes: 172_000_000,
    viewer: true,
  },
  "10m": {
    file: "beam-10m.json",
    repo: "Mohammadta/BEAM-10M",
    split: "10M",
    conversations: 10,
    approxBytes: 500_000_000,
    viewer: false,
  },
};

export const BEAM_HOMEPAGE = "https://huggingface.co/datasets/Mohammadta/BEAM";
export const BEAM_PAPER = "https://arxiv.org/abs/2510.27246";

export const isBeamSplit = (v: string): v is BeamSplit =>
  (BEAM_SPLITS as readonly string[]).includes(v);

export type DatasetName = FileDatasetName | "beam";
export const DATASET_NAMES: DatasetName[] = [
  ...(Object.keys(SOURCES) as FileDatasetName[]),
  "beam",
];
