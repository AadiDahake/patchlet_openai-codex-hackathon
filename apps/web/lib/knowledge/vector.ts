/**
 * A stored vector as numbers. pgvector hands it over as text (`[0.1,0.2]`), and a value that
 * does not parse into finite numbers is no vector at all.
 */
export function parseVector(value: unknown): number[] | null {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  for (const entry of parsed) if (typeof entry !== "number" || !Number.isFinite(entry)) return null;
  return parsed as number[];
}
