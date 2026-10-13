#!/usr/bin/env python3
"""Convert BEAM parquet shards to the JSON file the eval harness reads.

The 10M split of BEAM (Mohammadta/BEAM-10M) is too large for the Hugging Face datasets-server
(its rows are hundreds of MB), so `pnpm --filter @recall-memory/evals download` cannot fetch it
row by row like the other splits. Download the parquet files yourself and convert them:

  mkdir beam10m && cd beam10m          # an empty directory of its own; the files are untrusted data
  for n in 00000 00001; do
    curl -L -O https://huggingface.co/datasets/Mohammadta/BEAM-10M/resolve/main/data/10M-$n-of-00002.parquet
  done
  cd ..
  python3 -m venv .venv && .venv/bin/pip install pyarrow
  .venv/bin/python -I evals/tools/beam-parquet-to-json.py beam10m/10M-*.parquet evals/data/beam-10m.json

Writes a JSON array with the same fields as `download` stores for the other splits
(conversation_id, conversation_seed, chat, probing_questions); the generator's scaffolding
(plans, narratives, user_questions) is dropped. Run with `-I` so nothing is imported from the
current directory.
"""
import json
import sys

KEPT = ["conversation_id", "conversation_seed", "chat", "probing_questions"]


def main(argv):
    if len(argv) < 3:
        sys.exit(__doc__)
    import pyarrow.parquet as pq  # imported late so --help works without it

    *inputs, output = argv[1:]
    written = 0
    with open(output + ".part", "w", encoding="utf-8") as out:
        out.write("[\n")
        for path in sorted(inputs):
            pf = pq.ParquetFile(path)
            columns = [c for c in KEPT if c in pf.schema_arrow.names]
            for batch in pf.iter_batches(batch_size=1, columns=columns):
                for row in batch.to_pylist():
                    out.write(("," if written else "") + "\n" + json.dumps(row, ensure_ascii=False))
                    written += 1
                    print(f"converted {written} conversations", file=sys.stderr)
        out.write("\n]\n")
    import os

    os.replace(output + ".part", output)
    print(f"wrote {output} ({written} conversations)", file=sys.stderr)


if __name__ == "__main__":
    main(sys.argv)
