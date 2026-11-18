import type { NodeKind } from "@/lib/knowledge/graph";

/**
 * The shape a node kind is drawn with, centred on the origin.
 *
 * What the agent has read is round and green; the product is square and ink. The same four
 * shapes are the legend, the search results and the head of the detail panel, so a kind is
 * learnt once.
 */
export function NodeShape({ kind, radius }: { kind: NodeKind; radius: number }) {
  if (kind === "source") {
    return (
      <>
        <circle className="kmap-halo" r={radius + 4} />
        <circle className="kmap-shape" r={radius} />
      </>
    );
  }
  if (kind === "passage") return <circle className="kmap-shape" r={radius} />;
  const corner = kind === "page" ? radius * 0.34 : radius * 0.3;
  return (
    <rect className="kmap-shape" x={-radius} y={-radius} width={radius * 2} height={radius * 2} rx={corner} />
  );
}

/** The outline a selected node gets. It follows the node's own shape. */
export function NodeRing({ kind, radius, gap }: { kind: NodeKind; radius: number; gap: number }) {
  const reach = radius + gap;
  if (kind === "source" || kind === "passage") return <circle r={reach} />;
  const corner = kind === "page" ? reach * 0.34 : reach * 0.3;
  return <rect x={-reach} y={-reach} width={reach * 2} height={reach * 2} rx={corner} />;
}

const MARK_RADIUS: Record<NodeKind, number> = { source: 5, passage: 3.4, page: 4.6, control: 2.8 };

/** A node kind as a small inline mark, for text that names one. */
export function NodeMark({ kind }: { kind: NodeKind }) {
  return (
    <svg className={`kmap-mark is-${kind}`} width="16" height="16" viewBox="-8 -8 16 16" aria-hidden="true">
      <NodeShape kind={kind} radius={MARK_RADIUS[kind]} />
    </svg>
  );
}
