/**
 * A plane that keeps neighbours together.
 *
 * Two principal components keep about a fifth of what 1536 dimensions say, so on that plane a
 * passage often lands far from the passages it is nearest to. This starts from that plane and
 * then lets every passage be drawn toward its nearest passages, measured by cosine similarity
 * on the whole vector, while all passages push each other apart. On the NovaAir store the share
 * of nearest neighbours that are still nearest on the picture goes from 43% to 63%.
 *
 * It is deterministic: the start is the principal component plane, and d3-force takes its jitter
 * from a fixed sequence. The same vectors always give the same picture.
 */
import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY } from "d3-force";

/** How many nearest passages each passage is tied to. The detail panel shows the same number. */
export const NEIGHBOURS = 6;

export type NeighbourPlane = {
  /** One point per input vector, in input order. Both coordinates are inside -1 to 1. */
  points: [number, number][];
  /** Each passage and one of its nearest passages, as two indexes. Every pair appears once. */
  links: [number, number][];
  /** Share of every passage's nearest passages that are still its nearest on the plane, 0 to 1. */
  kept: number;
};

type Body = { index: number; x: number; y: number; homeX: number; homeY: number };
type Tie = { source: Body; target: Body; apart: number };

/** The size the simulation works at. Only the proportions between the numbers below matter. */
const FIELD = 260;
const STEPS = 300;

/** Each vector at length one, so a dot product is the cosine similarity. */
function unitRows(vectors: readonly ArrayLike<number>[], dimensions: number): Float64Array[] {
  return vectors.map((vector) => {
    const row = new Float64Array(dimensions);
    let squared = 0;
    for (let at = 0; at < dimensions; at += 1) {
      const value = vector[at] ?? 0;
      row[at] = value;
      squared += value * value;
    }
    const length = Math.sqrt(squared);
    if (length > 0) for (let at = 0; at < dimensions; at += 1) row[at] = (row[at] as number) / length;
    return row;
  });
}

/** The `count` highest-scoring others for one row, best first. Ties go to the lower index. */
function best(scores: ArrayLike<number>, self: number, count: number): number[] {
  const picked: number[] = [];
  for (let other = 0; other < scores.length; other += 1) {
    if (other === self) continue;
    const score = scores[other] as number;
    let at = picked.length;
    while (at > 0 && (scores[picked[at - 1] as number] as number) < score) at -= 1;
    if (at >= count) continue;
    picked.splice(at, 0, other);
    if (picked.length > count) picked.pop();
  }
  return picked;
}

/** Every vector's nearest vectors by cosine similarity, and how similar each pair is. */
export function nearestByCosine(
  vectors: readonly ArrayLike<number>[],
  count = NEIGHBOURS,
): { nearest: number[][]; similarity: (a: number, b: number) => number } {
  const size = vectors.length;
  const dimensions = vectors[0]?.length ?? 0;
  const rows = unitRows(vectors, dimensions);
  const table = new Float32Array(size * size);
  for (let a = 0; a < size; a += 1) {
    const rowA = rows[a] as Float64Array;
    for (let b = a + 1; b < size; b += 1) {
      const rowB = rows[b] as Float64Array;
      let sum = 0;
      for (let at = 0; at < dimensions; at += 1) sum += (rowA[at] as number) * (rowB[at] as number);
      table[a * size + b] = sum;
      table[b * size + a] = sum;
    }
  }
  const nearest = Array.from({ length: size }, (_, row) => best(table.subarray(row * size, (row + 1) * size), row, count));
  return { nearest, similarity: (a, b) => table[a * size + b] as number };
}

/** Share of each point's nearest vectors that are also among its nearest points on the plane. */
export function neighboursKept(points: readonly (readonly [number, number])[], nearest: readonly number[][]): number {
  const size = points.length;
  let kept = 0;
  let asked = 0;
  const closeness = new Float64Array(size);
  for (let row = 0; row < size; row += 1) {
    const wanted = nearest[row] ?? [];
    if (wanted.length === 0) continue;
    const [x, y] = points[row] as readonly [number, number];
    for (let other = 0; other < size; other += 1) {
      const [otherX, otherY] = points[other] as readonly [number, number];
      // Negated, so the closest point has the highest score.
      closeness[other] = -Math.hypot(otherX - x, otherY - y);
    }
    const onPlane = new Set(best(closeness, row, wanted.length));
    for (const neighbour of wanted) if (onPlane.has(neighbour)) kept += 1;
    asked += wanted.length;
  }
  return asked === 0 ? 1 : kept / asked;
}

const round = (value: number): number => Math.round(value * 1e4) / 1e4 + 0;

/**
 * Lays the vectors out so that near vectors are near points. `start` is where each one begins,
 * inside -1 to 1: the principal component plane.
 */
export function layoutByNeighbours(
  vectors: readonly ArrayLike<number>[],
  start: readonly (readonly [number, number])[],
): NeighbourPlane {
  const size = vectors.length;
  if (size === 0) return { points: [], links: [], kept: 1 };
  if (size === 1) return { points: [[0, 0]], links: [], kept: 1 };

  const { nearest, similarity } = nearestByCosine(vectors);
  const bodies: Body[] = Array.from({ length: size }, (_, index) => {
    const x = (start[index]?.[0] ?? 0) * FIELD;
    const y = (start[index]?.[1] ?? 0) * FIELD;
    return { index, x, y, homeX: x, homeY: y };
  });

  const links: [number, number][] = [];
  const ties: Tie[] = [];
  const seen = new Set<number>();
  nearest.forEach((neighbours, a) => {
    for (const b of neighbours) {
      const low = Math.min(a, b);
      const high = Math.max(a, b);
      const pair = low * size + high;
      if (seen.has(pair)) continue;
      seen.add(pair);
      links.push([low, high]);
      // Cosine distance: zero for the same text, about one for unrelated text.
      ties.push({ source: bodies[low] as Body, target: bodies[high] as Body, apart: 1 - similarity(low, high) });
    }
  });

  const simulation = forceSimulation<Body, Tie>(bodies)
    .force(
      "ties",
      forceLink<Body, Tie>(ties)
        .distance((tie) => 6 + 70 * tie.apart)
        .strength(0.5),
    )
    .force("push", forceManyBody<Body>().strength(-22).distanceMax(FIELD))
    .force("room", forceCollide<Body>(4.2))
    // A light hold on where the principal components put it, so the picture keeps its broad shape.
    .force("homeX", forceX<Body>((body) => body.homeX).strength(0.02))
    .force("homeY", forceY<Body>((body) => body.homeY).strength(0.02))
    .stop();
  for (let step = 0; step < STEPS; step += 1) simulation.tick();

  // Centred on the middle of the cloud and scaled by one number, so distance means the same
  // in every direction.
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const body of bodies) {
    minX = Math.min(minX, body.x);
    maxX = Math.max(maxX, body.x);
    minY = Math.min(minY, body.y);
    maxY = Math.max(maxY, body.y);
  }
  const middleX = (minX + maxX) / 2;
  const middleY = (minY + maxY) / 2;
  const reach = Math.max(maxX - minX, maxY - minY) / 2;
  const points = bodies.map((body): [number, number] =>
    reach > 0 ? [round((body.x - middleX) / reach), round((body.y - middleY) / reach)] : [0, 0],
  );
  return { points, links, kept: round(neighboursKept(points, nearest)) };
}
