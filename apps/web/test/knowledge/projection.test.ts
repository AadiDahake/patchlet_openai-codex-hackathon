import { describe, expect, it } from "vitest";
import { layoutByNeighbours, nearestByCosine, neighboursKept } from "@/lib/knowledge/neighbours";
import { projectToPlane } from "@/lib/knowledge/projection";

/** A fixed sequence in place of a random source, so every run sees the same cloud. */
function sequence(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296 - 0.5;
  };
}

/** `count` vectors of `dimensions` numbers that vary most along axis 0, then along axis 1. */
function cloud(count: number, dimensions: number, seed = 7): number[][] {
  const next = sequence(seed);
  return Array.from({ length: count }, () =>
    Array.from({ length: dimensions }, (_, axis) => next() * (axis === 0 ? 10 : axis === 1 ? 4 : 0.2)),
  );
}

/** Three tight groups far apart in a long space, as three topics would be. */
function topics(perTopic: number, dimensions = 24): { vectors: number[][]; topic: number[] } {
  const next = sequence(11);
  const centres = [0, 1, 2].map((group) =>
    Array.from({ length: dimensions }, (_, axis) => (axis % 3 === group ? 1 : 0) + next() * 0.05),
  );
  const vectors: number[][] = [];
  const topic: number[] = [];
  centres.forEach((centre, group) => {
    for (let n = 0; n < perTopic; n += 1) {
      vectors.push(centre.map((value) => value + next() * 0.08));
      topic.push(group);
    }
  });
  return { vectors, topic };
}

const distance = (a: readonly number[], b: readonly number[]): number => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!);

describe("projectToPlane", () => {
  it("puts points on a line onto one axis, which then carries everything", () => {
    const line = [-1, 0, 1, 2, 4].map((t) => [3 * t, 4 * t, 0]);
    const { points, explained } = projectToPlane(line);
    expect(explained).toEqual([1, 0]);
    // Evenly spaced along the line, and the point furthest from the middle is on the positive side.
    expect(points.map((point) => point[0])).toEqual([-0.7857, -0.4286, -0.0714, 0.2857, 1]);
    expect(points.every((point) => point[1] === 0)).toBe(true);
  });

  it("fixes the mirror image: the furthest point is positive, and a tie goes to the earlier point", () => {
    expect(projectToPlane([[0, 0], [2, 0]]).points).toEqual([[1, 0], [-1, 0]]);
    expect(projectToPlane([[2, 0], [0, 0]]).points).toEqual([[1, 0], [-1, 0]]);
    expect(projectToPlane([[0, 0], [1, 0], [5, 0]]).points.map((point) => point[0])).toEqual([-0.6667, -0.3333, 1]);
  });

  it("finds the two directions a cloud spreads along the most", () => {
    const vectors = cloud(200, 12);
    const { points, explained } = projectToPlane(vectors);
    // Axis 0 varies 2.5 times as far as axis 1, so about 6.25 times the variance.
    expect(explained[0]).toBeGreaterThan(0.8);
    expect(explained[0] / explained[1]).toBeGreaterThan(5);
    expect(explained[0] + explained[1]).toBeGreaterThan(0.99);
    // The first coordinate is the cloud's own first axis, up to a mirror image.
    const along = vectors.map((vector, at) => vector[0]! * points[at]![0]!);
    const sign = Math.sign(along.reduce((sum, value) => sum + value, 0));
    expect(along.filter((value) => Math.sign(value) === sign).length).toBeGreaterThan(190);
  });

  it("keeps every point inside the unit square and reaches its edge", () => {
    const { points } = projectToPlane(cloud(80, 30));
    const reach = Math.max(...points.flatMap((point) => [Math.abs(point[0]), Math.abs(point[1])]));
    expect(reach).toBe(1);
  });

  it("gives the same picture for the same vectors, every time", () => {
    const vectors = cloud(60, 40);
    expect(projectToPlane(vectors)).toEqual(projectToPlane(vectors.map((vector) => [...vector])));
  });

  it("does not care where the cloud is or how large its numbers are", () => {
    const vectors = cloud(50, 16);
    const moved = vectors.map((vector) => vector.map((value) => value * 250 + 1000));
    const a = projectToPlane(vectors).points;
    const b = projectToPlane(moved).points;
    a.forEach((point, at) => {
      expect(b[at]![0]).toBeCloseTo(point[0], 3);
      expect(b[at]![1]).toBeCloseTo(point[1], 3);
    });
  });

  it("puts passages on the same topic together and different topics apart", () => {
    const { vectors, topic } = topics(8);
    const { points } = projectToPlane(vectors);
    let within = 0;
    let across = Infinity;
    for (let a = 0; a < points.length; a += 1) {
      for (let b = a + 1; b < points.length; b += 1) {
        const apart = distance(points[a]!, points[b]!);
        if (topic[a] === topic[b]) within = Math.max(within, apart);
        else across = Math.min(across, apart);
      }
    }
    expect(within).toBeLessThan(across / 3);
  });

  it("has an answer for no vectors, one vector, two vectors and vectors that are all the same", () => {
    expect(projectToPlane([])).toEqual({ points: [], explained: [0, 0] });
    expect(projectToPlane([[1, 2, 3]])).toEqual({ points: [[0, 0]], explained: [0, 0] });
    expect(projectToPlane([[0, 0], [2, 0]]).explained).toEqual([1, 0]);
    expect(projectToPlane([[5, 5], [5, 5], [5, 5]]).points).toEqual([[0, 0], [0, 0], [0, 0]]);
  });

  it("never returns a number that is not finite", () => {
    const { points, explained } = projectToPlane(cloud(40, 1536, 3));
    expect([...points.flat(), ...explained].every(Number.isFinite)).toBe(true);
  });
});

describe("nearestByCosine", () => {
  it("ranks by direction, not by length", () => {
    const { nearest, similarity } = nearestByCosine(
      [
        [1, 0],
        [10, 0.5],
        [0, 1],
        [-1, 0],
      ],
      2,
    );
    expect(nearest[0]).toEqual([1, 2]);
    expect(nearest[3]).toEqual([2, 1]);
    expect(similarity(0, 1)).toBeCloseTo(0.9988, 3);
    expect(similarity(0, 3)).toBeCloseTo(-1, 5);
  });

  it("never names a vector as its own neighbour and breaks a tie by position", () => {
    const { nearest } = nearestByCosine([[1, 0], [1, 0], [1, 0]], 5);
    expect(nearest).toEqual([[1, 2], [0, 2], [0, 1]]);
  });
});

describe("neighboursKept", () => {
  it("is one when the plane keeps every neighbour and falls when it does not", () => {
    const nearest = [[1], [0], [3], [2]];
    expect(neighboursKept([[0, 0], [0.1, 0], [5, 5], [5.1, 5]], nearest)).toBe(1);
    expect(neighboursKept([[0, 0], [5, 5], [0.1, 0], [5.1, 5]], nearest)).toBe(0);
    expect(neighboursKept([], [])).toBe(1);
  });
});

describe("layoutByNeighbours", () => {
  it("keeps more nearest neighbours together than the principal component plane does", () => {
    // Six topics need more than two directions to tell apart, so the flat plane folds some together.
    const next = sequence(5);
    const vectors: number[][] = [];
    for (let group = 0; group < 6; group += 1) {
      for (let n = 0; n < 10; n += 1) {
        vectors.push(Array.from({ length: 32 }, (_, axis) => (axis % 6 === group ? 1 : 0) + next() * 0.5));
      }
    }
    const start = projectToPlane(vectors).points;
    const { nearest } = nearestByCosine(vectors);
    const refined = layoutByNeighbours(vectors, start);
    expect(refined.kept).toBeGreaterThan(neighboursKept(start, nearest) + 0.05);
    expect(refined.kept).toBeCloseTo(neighboursKept(refined.points, nearest), 3);
  });

  it("ties each passage to its nearest passages, once per pair, by index", () => {
    const { vectors } = topics(5);
    const { links, points } = layoutByNeighbours(vectors, projectToPlane(vectors).points);
    expect(points).toHaveLength(15);
    expect(new Set(links.map(([a, b]) => `${a}-${b}`)).size).toBe(links.length);
    expect(links.every(([a, b]) => a < b && b < 15)).toBe(true);
    // With five to a topic and six neighbours each, every passage is tied to its whole topic.
    const topicOf = (at: number): number => Math.floor(at / 5);
    expect(links.filter(([a, b]) => topicOf(a) === topicOf(b))).toHaveLength(30);
  });

  it("gives the same picture for the same vectors, inside the unit square", () => {
    const { vectors } = topics(6);
    const start = projectToPlane(vectors).points;
    const first = layoutByNeighbours(vectors, start);
    expect(layoutByNeighbours(vectors, start)).toEqual(first);
    expect(Math.max(...first.points.flatMap((point) => [Math.abs(point[0]), Math.abs(point[1])]))).toBe(1);
  });

  it("has an answer for no passages and for one", () => {
    expect(layoutByNeighbours([], [])).toEqual({ points: [], links: [], kept: 1 });
    expect(layoutByNeighbours([[1, 2]], [[0, 0]])).toEqual({ points: [[0, 0]], links: [], kept: 1 });
  });
});
