"use client";

import { memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Ref } from "react";
import { PASSAGE_RADIUS, nodeKey, type MapIndex, type NodeRef } from "@/lib/knowledge/graph";
import type { NearPassage, VectorLayout } from "@/lib/knowledge/types";
import type { FocusRequest, ViewHandle } from "./GraphView";
import { NodeRing } from "./NodeMark";
import { useZoomPan, type Box, type Inset } from "./useZoomPan";

type Props = {
  index: MapIndex;
  layout: VectorLayout;
  selected: NodeRef | null;
  hinted: NodeRef | null;
  /** The passages pgvector returned as nearest to the selected passage. */
  near: readonly NearPassage[];
  focus: FocusRequest | null;
  reducedMotion: boolean;
  inset: Inset;
  onSelect: (ref: NodeRef | null) => void;
  handle: Ref<ViewHandle>;
};

/** The layout arrives inside -1 to 1; this is how large that is in the picture's own units. */
const SPREAD = 230;
const DOT_RADIUS = PASSAGE_RADIUS + 1.2;
const WHOLE: Box = { x0: -SPREAD, y0: -SPREAD, x1: SPREAD, y1: SPREAD };
/** The closest a search or a panel link brings the picture to a passage. */
const FOCUS_SCALE = 1.3;

type Dot = { id: string; key: string; x: number; y: number; label: string; sourceId: string; readFrom: string | null };

const DotGlyph = memo(function DotGlyph({
  dot,
  lit,
  selected,
  near,
}: {
  dot: Dot;
  lit: boolean;
  selected: boolean;
  near: boolean;
}) {
  const state = `${lit ? " is-lit" : ""}${selected ? " is-selected" : ""}${near ? " is-near" : ""}`;
  return (
    <g className={`kmap-node is-passage${state}`} data-node={dot.id} transform={`translate(${dot.x},${dot.y})`}>
      <circle className="kmap-hit" r={9} />
      <circle className="kmap-shape" r={DOT_RADIUS} />
    </g>
  );
});

type Mesh = { key: string; a: Dot; b: Dot };

/**
 * Which passages a pointed-at node lights up in this view: a passage and the passages it is tied
 * to, or everything a source holds, or everything read from a page.
 */
function litDots(dots: readonly Dot[], mesh: readonly Mesh[], pointed: NodeRef | null): Set<string> | null {
  if (!pointed) return null;
  if (pointed.kind === "source") return new Set(dots.filter((dot) => dot.sourceId === pointed.id).map((dot) => dot.id));
  if (pointed.kind === "page") return new Set(dots.filter((dot) => dot.readFrom === pointed.id).map((dot) => dot.id));
  if (pointed.kind !== "passage") return null;
  const lit = new Set([pointed.id]);
  for (const line of mesh) {
    if (line.a.id === pointed.id) lit.add(line.b.id);
    else if (line.b.id === pointed.id) lit.add(line.a.id);
  }
  return lit;
}

const MeshLine = memo(function MeshLine({ line, lit }: { line: Mesh; lit: boolean }) {
  return (
    <line
      className={`kmap-link is-mesh${lit ? " is-lit" : ""}`}
      x1={line.a.x}
      y1={line.a.y}
      x2={line.b.x}
      y2={line.b.y}
    />
  );
});

/**
 * The vector store: every passage as a point, placed by the server from its stored embedding and
 * tied to its nearest passages. The lines are the store's own neighbourhoods, so a cluster on the
 * picture is a cluster in the vectors.
 */
export function VectorView({ index, layout, selected, hinted, near, focus, reducedMotion, inset, onSelect, handle }: Props) {
  const { svgRef, layerRef, stage } = useZoomPan(reducedMotion, inset);
  const [hovered, setHovered] = useState<string | null>(null);

  const dots = useMemo<Dot[]>(() => {
    const placed: Dot[] = [];
    for (const point of layout.points) {
      const passage = index.passages.get(point.id);
      // A point with no passage behind it was added after the picture was read. It is skipped.
      if (!passage) continue;
      placed.push({
        id: passage.id,
        key: nodeKey("passage", passage.id),
        x: point.x * SPREAD,
        // The projection's second axis points up; the screen's points down.
        y: -point.y * SPREAD,
        label: passage.label,
        sourceId: passage.sourceId,
        readFrom: passage.readFrom,
      });
    }
    return placed;
  }, [index, layout]);
  const byId = useMemo(() => new Map(dots.map((dot) => [dot.id, dot])), [dots]);
  const mesh = useMemo<Mesh[]>(() => {
    const lines: Mesh[] = [];
    for (const [first, second] of layout.links) {
      const a = byId.get(layout.points[first]?.id ?? "");
      const b = byId.get(layout.points[second]?.id ?? "");
      if (a && b) lines.push({ key: `${a.id}:${b.id}`, a, b });
    }
    return lines;
  }, [layout, byId]);

  const pointed = useMemo<NodeRef | null>(() => {
    if (hovered) return { kind: "passage", id: hovered };
    const asked = hinted ?? selected;
    // A passage past the store's limit has no point here, so it cannot be what the picture dims around.
    return asked?.kind === "passage" && !byId.has(asked.id) ? null : asked;
  }, [hovered, hinted, selected, byId]);
  const lit = useMemo(() => litDots(dots, mesh, pointed), [dots, mesh, pointed]);
  const focusId = pointed?.kind === "passage" ? pointed.id : null;
  const nearIds = useMemo(() => new Set(near.map((entry) => entry.id)), [near]);

  const fitted = useRef(false);
  const fit = useCallback((animate: boolean) => stage.show(WHOLE, { maxScale: 2, animate, whole: true }), [stage]);
  useImperativeHandle(handle, () => ({ fit: () => fit(true), zoomBy: stage.zoomBy }), [fit, stage]);

  useLayoutEffect(() => {
    if (fitted.current) return;
    fitted.current = true;
    fit(false);
  }, [fit]);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const observer = new ResizeObserver(() => {
      if (!stage.moved()) fit(false);
    });
    observer.observe(svg);
    return () => observer.disconnect();
  }, [svgRef, stage, fit]);

  // The detail panel opened or closed: while the person has not moved the picture, all of it
  // stays in view beside the panel.
  const fittedInset = useRef(inset);
  useEffect(() => {
    if (fittedInset.current === inset) return;
    fittedInset.current = inset;
    if (!stage.moved()) fit(true);
  }, [inset, stage, fit]);

  // Once the person has moved the picture: a search result or a panel link brings a passage to
  // the middle, or fits everything a source holds.
  useEffect(() => {
    if (!focus || !stage.moved()) return;
    if (focus.ref.kind === "passage") {
      const dot = byId.get(focus.ref.id);
      if (dot) stage.centreOn(dot.x, dot.y, FOCUS_SCALE);
      return;
    }
    const held = dots.filter((dot) =>
      focus.ref.kind === "source" ? dot.sourceId === focus.ref.id : dot.readFrom === focus.ref.id,
    );
    if (held.length === 0) return;
    stage.show(
      {
        x0: Math.min(...held.map((dot) => dot.x)) - 24,
        y0: Math.min(...held.map((dot) => dot.y)) - 24,
        x1: Math.max(...held.map((dot) => dot.x)) + 24,
        y1: Math.max(...held.map((dot) => dot.y)) + 24,
      },
      { maxScale: 2.4 },
    );
  }, [focus, byId, dots, stage]);

  const selectedDot = selected?.kind === "passage" ? byId.get(selected.id) : undefined;
  useEffect(() => {
    if (selectedDot && stage.moved()) stage.reveal(selectedDot.x, selectedDot.y);
  }, [selectedDot, stage, inset]);

  const idOf = (target: EventTarget | null): string | null =>
    (target as Element | null)?.closest?.<SVGGElement>("[data-node]")?.dataset.node ?? null;

  const hoveredDot = hovered ? byId.get(hovered) : undefined;
  const named = [hoveredDot, selectedDot].filter(
    (dot, at, all): dot is Dot => dot !== undefined && all.indexOf(dot) === at,
  );

  return (
    <svg
      ref={svgRef}
      className={`kmap-svg is-vectors${lit ? " has-focus" : ""}`}
      role="group"
      aria-label="Vector store. Each point is a passage. Use the search box to find one."
      onClick={(event) => {
        const id = idOf(event.target);
        onSelect(id ? { kind: "passage", id } : null);
      }}
    >
      <g ref={layerRef}>
        <g className="kmap-links">
          {mesh.map((line) => (
            <MeshLine key={line.key} line={line} lit={focusId !== null && (line.a.id === focusId || line.b.id === focusId)} />
          ))}
          {selectedDot
            ? near.map((entry) => {
                const dot = byId.get(entry.id);
                return dot ? (
                  <line
                    key={entry.id}
                    className="kmap-link is-nearest is-lit"
                    x1={selectedDot.x}
                    y1={selectedDot.y}
                    x2={dot.x}
                    y2={dot.y}
                  />
                ) : null;
              })
            : null}
        </g>
        <g
          className="kmap-nodes"
          onPointerOver={(event) => {
            const id = idOf(event.target);
            if (id) setHovered(id);
          }}
          onPointerOut={(event) => {
            if (!idOf(event.relatedTarget)) setHovered(null);
          }}
        >
          {dots.map((dot) => (
            <DotGlyph
              key={dot.id}
              dot={dot}
              lit={lit?.has(dot.id) ?? false}
              selected={dot.id === selectedDot?.id}
              near={selectedDot !== undefined && nearIds.has(dot.id)}
            />
          ))}
        </g>
        <g className="kmap-top" data-scale="">
          {selectedDot
            ? dots
                .filter((dot) => nearIds.has(dot.id))
                .map((dot) => (
                  <g key={`near-${dot.id}`} className="kmap-ring is-near" transform={`translate(${dot.x},${dot.y})`}>
                    <NodeRing kind="passage" radius={DOT_RADIUS} gap={2.6} />
                  </g>
                ))
            : null}
          {selectedDot ? (
            <g className="kmap-ring" transform={`translate(${selectedDot.x},${selectedDot.y})`}>
              <NodeRing kind="passage" radius={DOT_RADIUS} gap={3.4} />
            </g>
          ) : null}
          {named.map((dot) => (
            <g
              key={`name-${dot.id}`}
              transform={`translate(${dot.x},${dot.y})`}
              style={{ "--r": DOT_RADIUS } as React.CSSProperties}
            >
              {/* Two lines above the point: the first is lifted by one line so the second ends at the gap. */}
              <text className="kmap-label is-floating" textAnchor="middle">
                <tspan x="0" dy="-1.3em">
                  {dot.label}
                </tspan>
                <tspan className="kmap-label__sub" x="0" dy="1.3em">
                  {index.sources.get(dot.sourceId)?.title}
                </tspan>
              </text>
            </g>
          ))}
        </g>
      </g>
    </svg>
  );
}
