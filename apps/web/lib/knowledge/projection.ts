/**
 * A set of long vectors, laid out on a plane.
 *
 * The plane is the one the vectors spread across the most: their first two principal components.
 * Passages that read alike have nearby vectors, and a projection onto the widest plane keeps as
 * much of that nearness as two numbers can. The same vectors always give the same picture: the
 * power iteration starts from a fixed seed and nothing here reads a clock or a random source.
 *
 * The covariance matrix is never built. One step multiplies by the centred rows and back, which
 * costs rows times dimensions, so a few thousand vectors of 1536 numbers stay well inside the
 * time a request has.
 */

export type PlaneProjection = {
  /** One point per input vector, in input order. Both coordinates are inside -1 to 1. */
  points: [number, number][];
  /** Share of the total variance each axis carries, 0 to 1. */
  explained: [number, number];
};

const MAX_STEPS = 300;
/** How far one step may still turn the axis before it counts as settled. */
const SETTLED = 1e-10;
/** Below this share of the total variance there is no direction left to find. */
const NOTHING_LEFT = 1e-12;

/** A small fixed-seed generator: the same start every run, in no special direction. */
function seededStart(length: number, seed: number): Float64Array {
  const start = new Float64Array(length);
  let state = seed >>> 0;
  for (let index = 0; index < length; index += 1) {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), state | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    start[index] = ((mixed ^ (mixed >>> 14)) >>> 0) / 2 ** 31 - 1;
  }
  return start;
}

function dot(a: Float64Array, b: Float64Array): number {
  let sum = 0;
  for (let index = 0; index < a.length; index += 1) sum += (a[index] as number) * (b[index] as number);
  return sum;
}

/** Removes from `vector` whatever it shares with each of the axes already found. */
function removeAxes(vector: Float64Array, axes: readonly Float64Array[]): void {
  for (const axis of axes) {
    const shared = dot(vector, axis);
    for (let index = 0; index < vector.length; index += 1) {
      vector[index] = (vector[index] as number) - shared * (axis[index] as number);
    }
  }
}

function normalise(vector: Float64Array): number {
  const length = Math.sqrt(dot(vector, vector));
  if (length > 0) for (let index = 0; index < vector.length; index += 1) vector[index] = (vector[index] as number) / length;
  return length;
}

/** The centred rows and how much they vary in all. */
function centre(vectors: readonly ArrayLike<number>[], dimensions: number): { rows: Float64Array[]; total: number } {
  const mean = new Float64Array(dimensions);
  for (const vector of vectors) {
    for (let index = 0; index < dimensions; index += 1) mean[index] = (mean[index] as number) + (vector[index] ?? 0);
  }
  for (let index = 0; index < dimensions; index += 1) mean[index] = (mean[index] as number) / vectors.length;

  let total = 0;
  const rows = vectors.map((vector) => {
    const row = new Float64Array(dimensions);
    for (let index = 0; index < dimensions; index += 1) {
      const value = (vector[index] ?? 0) - (mean[index] as number);
      row[index] = value;
      total += value * value;
    }
    return row;
  });
  return { rows, total };
}

/**
 * The direction the rows spread along the most, outside the axes already found. Null when what
 * is left does not vary.
 */
function widestAxis(
  rows: readonly Float64Array[],
  found: readonly Float64Array[],
  total: number,
  seed: number,
): Float64Array | null {
  const dimensions = rows[0]?.length ?? 0;
  let axis = seededStart(dimensions, seed);
  removeAxes(axis, found);
  if (normalise(axis) === 0) return null;

  for (let step = 0; step < MAX_STEPS; step += 1) {
    const next = new Float64Array(dimensions);
    for (const row of rows) {
      const along = dot(row, axis);
      if (along === 0) continue;
      for (let index = 0; index < dimensions; index += 1) {
        next[index] = (next[index] as number) + along * (row[index] as number);
      }
    }
    removeAxes(next, found);
    // Before normalising, the length of `next` is the variance along the axis.
    if (normalise(next) <= total * NOTHING_LEFT) return null;
    const turned = 1 - Math.abs(dot(next, axis));
    axis = next;
    if (turned < SETTLED) break;
  }
  return axis;
}

/** Points the axis so its furthest point is on the positive side, which fixes the mirror image. */
function orient(values: Float64Array): void {
  let furthest = 0;
  for (const value of values) if (Math.abs(value) > Math.abs(furthest)) furthest = value;
  if (furthest < 0) for (let index = 0; index < values.length; index += 1) values[index] = -(values[index] as number);
}

const round = (value: number): number => Math.round(value * 1e4) / 1e4 + 0;

/** Lays the vectors out on their first two principal components. */
export function projectToPlane(vectors: readonly ArrayLike<number>[]): PlaneProjection {
  const count = vectors.length;
  const dimensions = vectors[0]?.length ?? 0;
  const flat = (): PlaneProjection => ({ points: vectors.map(() => [0, 0]), explained: [0, 0] });
  if (count < 2 || dimensions === 0) return flat();

  const { rows, total } = centre(vectors, dimensions);
  if (!(total > 0)) return flat();

  const first = widestAxis(rows, [], total, 1);
  if (!first) return flat();
  const second = widestAxis(rows, [first], total, 2);

  const xs = new Float64Array(count);
  const ys = new Float64Array(count);
  rows.forEach((row, index) => {
    xs[index] = dot(row, first);
    if (second) ys[index] = dot(row, second);
  });
  const explained: [number, number] = [dot(xs, xs) / total, dot(ys, ys) / total];
  orient(xs);
  orient(ys);

  // One scale for both axes, so a distance on the picture means the same in every direction.
  let reach = 0;
  for (let index = 0; index < count; index += 1) {
    reach = Math.max(reach, Math.abs(xs[index] as number), Math.abs(ys[index] as number));
  }
  if (!(reach > 0)) return flat();
  return {
    points: Array.from({ length: count }, (_, index) => [
      round((xs[index] as number) / reach),
      round((ys[index] as number) / reach),
    ]),
    explained: [round(explained[0]), round(explained[1])],
  };
}
