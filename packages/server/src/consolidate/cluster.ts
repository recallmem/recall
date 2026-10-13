import { cosine } from "../reasoner/util.js";

/**
 * Deterministic single-linkage clustering with a size cap: pairs above the
 * similarity threshold are linked in descending similarity order (ties by
 * index), and a link that would grow a cluster past `maxSize` is skipped.
 * Returns clusters as index lists, each sorted, ordered by first member.
 */
export function clusterBySimilarity(
  vectors: number[][],
  opts: { threshold: number; maxSize: number },
): number[][] {
  const n = vectors.length;
  const edges: { i: number; j: number; s: number }[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const s = cosine(vectors[i]!, vectors[j]!);
      if (s >= opts.threshold) edges.push({ i, j, s });
    }
  }
  edges.sort((a, b) => b.s - a.s || a.i - b.i || a.j - b.j);
  const parent = Array.from({ length: n }, (_, i) => i);
  const size = new Array<number>(n).fill(1);
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]!]!;
      x = parent[x]!;
    }
    return x;
  };
  for (const { i, j } of edges) {
    const a = find(i);
    const b = find(j);
    if (a === b || size[a]! + size[b]! > opts.maxSize) continue;
    const [root, child] = a < b ? [a, b] : [b, a];
    parent[child] = root;
    size[root]! += size[child]!;
  }
  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    groups.set(r, [...(groups.get(r) ?? []), i]);
  }
  return [...groups.values()].sort((a, b) => a[0]! - b[0]!);
}

/**
 * Packs clusters into call-sized groups (returned as lists of clusters) (first-fit decreasing, multi-member
 * clusters before singletons) under a per-call and a total token budget.
 * Clusters that do not fit are left for the next dream.
 */
export function packClusters(
  clusters: number[][],
  tokens: (i: number) => number,
  opts: { maxTokensPerCall: number; maxCalls: number; maxTotalTokens: number },
): number[][][] {
  const weight = (c: number[]) => c.reduce((n, i) => n + tokens(i), 0);
  const ordered = [...clusters].sort(
    (a, b) => Number(b.length > 1) - Number(a.length > 1) || weight(b) - weight(a) || a[0]! - b[0]!,
  );
  const bins: { clusters: number[][]; used: number }[] = [];
  let total = 0;
  for (const c of ordered) {
    const w = weight(c);
    if (w > opts.maxTokensPerCall || total + w > opts.maxTotalTokens) continue;
    let bin = bins.find((b) => b.used + w <= opts.maxTokensPerCall);
    if (!bin) {
      if (bins.length >= opts.maxCalls) continue;
      bin = { clusters: [], used: 0 };
      bins.push(bin);
    }
    bin.clusters.push(c);
    bin.used += w;
    total += w;
  }
  return bins.map((b) => b.clusters);
}
