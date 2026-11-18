"use client";

import { memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Ref } from "react";
import {
  keyOf,
  litBy,
  nodeKey,
  openedBy,
  visibleGraph,
  type GraphLink,
  type GraphNode,
  type MapIndex,
  type NodeRef,
} from "@/lib/knowledge/graph";
import { GraphLayout, crowdedNames, nameWidth, type Lie, type NameBox, type Point } from "@/lib/knowledge/layout";
import { NodeRing, NodeShape } from "./NodeMark";
import { useZoomPan, type Inset } from "./useZoomPan";

/** What the toolbar can ask of whichever view is showing. */
export type ViewHandle = { fit: () => void; zoomBy: (factor: number) => void };

/**
 * The positions a layout ended on, kept by whoever outlives this view. They are asked for by the
 * way the stage lies, because positions worked out for a wide stage are the wrong shape for a
 * tall one.
 */
export type SavedLayout = {
  recall: (lie: Lie) => ReadonlyMap<string, Point>;
  keep: (lie: Lie, points: Map<string, Point>) => void;
};

/** A request to bring a node to the middle. The token makes two requests for one node distinct. */
export type FocusRequest = { ref: NodeRef; token: number };

type Props = {
  index: MapIndex;
  selected: NodeRef | null;
  /** A node pointed at from outside the picture: a row in the detail panel, a search result. */
  hinted: NodeRef | null;
  /** Passages near the selected passage. They are marked, never linked: nearness is not a stored link. */
  near: readonly string[];
  focus: FocusRequest | null;
  /** Where the nodes were when this view last closed, so the picture is the same on return. */
  saved: SavedLayout;
  reducedMotion: boolean;
  inset: Inset;
  onSelect: (ref: NodeRef | null) => void;
  handle: Ref<ViewHandle>;
};

/** A pointer has to travel this far before a press becomes a drag. */
const DRAG_SLOP = 4;
/** How much energy the layout gets back when a page opens or closes. One is a cold start. */
const REHEAT = 0.4;
/** A stage this much taller than it is wide stacks the two sides instead of setting them side by side. */
const TALL = 1.05;
/** Screen pixels: the gap under a node, one line of a name, and a name with its count under it. */
const NAME_DROP = 6;
const NAME_LINE = 16;
const NAME_TWO_LINES = 30;
/** Screen pixels kept clear between two names on one line, so they never read as one. */
const NAME_SPACE = 14;
/** The closest a search or a panel link brings the picture to a node. */
const FOCUS_SCALE = 1.2;
/** Small nodes are drawn first, so a source or a page is never under a dot. */
const PAINT_ORDER: Record<GraphNode["kind"], number> = { control: 0, passage: 1, page: 2, source: 3 };

const NodeGlyph = memo(function NodeGlyph({
  node,
  lit,
  selected,
  near,
}: {
  node: GraphNode;
  lit: boolean;
  selected: boolean;
  near: boolean;
}) {
  const named = node.kind === "source" || node.kind === "page";
  const state = `${lit ? " is-lit" : ""}${selected ? " is-selected" : ""}${near ? " is-near" : ""}`;
  return (
    <g
      className={`kmap-node is-${node.kind}${state}`}
      data-node={node.key}
      {...(named
        ? { tabIndex: 0, role: "button", "aria-label": `${node.kind}: ${node.label}, ${node.sub ?? ""}` }
        : {})}
    >
      <circle className="kmap-hit" r={Math.max(node.radius + 3, 9)} />
      <NodeShape kind={node.kind} radius={node.radius} />
    </g>
  );
});

/**
 * The name under a source or a page, with its count. Names are a layer of their own, above the
 * nodes: a dot never covers one, and a zoom restyles only this layer.
 */
const NameGlyph = memo(function NameGlyph({
  node,
  lit,
  pointed,
  selected,
}: {
  node: GraphNode;
  lit: boolean;
  pointed: boolean;
  selected: boolean;
}) {
  const state = `${lit ? " is-lit" : ""}${pointed ? " is-pointed" : ""}${selected ? " is-selected" : ""}`;
  return (
    <g className={`kmap-name${state}`} data-follow={node.key} style={{ "--r": node.radius } as React.CSSProperties}>
      <text className="kmap-label" textAnchor="middle">
        {node.label}
        <tspan className="kmap-label__sub" x="0" dy="1.3em">
          {node.sub}
        </tspan>
      </text>
    </g>
  );
});

const LinkLine = memo(function LinkLine({ link, lit }: { link: GraphLink; lit: boolean }) {
  return <line className={`kmap-link is-${link.kind}${lit ? " is-lit" : ""}`} data-link={link.key} />;
});

/** The knowledge graph: sources and their passages, pages and their controls, and the stored links. */
export function GraphView({ index, selected, hinted, near, focus, saved, reducedMotion, inset, onSelect, handle }: Props) {
  // A zoom changes which names have room, so the stage calls back into the latest `paint`.
  const repaint = useRef<() => void>(() => undefined);
  const onScale = useCallback(() => repaint.current(), []);
  const { svgRef, layerRef, stage } = useZoomPan(reducedMotion, inset, onScale);
  const [hovered, setHovered] = useState<NodeRef | null>(null);

  const opened = openedBy(index, selected);
  const graph = useMemo(
    () => visibleGraph(index, { sourceId: opened.sourceId, route: opened.route }),
    [index, opened.sourceId, opened.route],
  );
  const drawn = useMemo(
    () => [...graph.nodes].sort((a, b) => PAINT_ORDER[a.kind] - PAINT_ORDER[b.kind]),
    [graph],
  );
  const byKey = useMemo(() => new Map(graph.nodes.map((node) => [node.key, node])), [graph]);

  // A row in the panel can name a node that is not drawn: a control of a closed page. What it
  // hangs from is lit in its place, so pointing at a row always shows where it is.
  const hintedDrawn = useMemo<NodeRef | null>(() => {
    if (!hinted || byKey.has(keyOf(hinted))) return hinted;
    const parent: NodeRef | null =
      hinted.kind === "control"
        ? { kind: "page", id: index.controls.get(hinted.id)?.route ?? "" }
        : hinted.kind === "passage"
          ? { kind: "source", id: index.passages.get(hinted.id)?.sourceId ?? "" }
          : null;
    return parent && byKey.has(keyOf(parent)) ? parent : null;
  }, [hinted, byKey, index]);
  const pointed = hovered ?? hintedDrawn ?? selected;
  const lit = useMemo(() => litBy(index, graph, pointed), [index, graph, pointed]);
  const nearKeys = useMemo(() => new Set(near.map((id) => nodeKey("passage", id))), [near]);

  const layout = useRef<GraphLayout | null>(null);
  const nodeElements = useRef(new Map<string, SVGGElement>());
  const linkElements = useRef(new Map<string, SVGLineElement>());
  const fitted = useRef(false);
  const settledFor = useRef<typeof graph | null>(null);
  const still = useRef(reducedMotion);
  /** The names that are never left out: the one pointed at and the one selected. */
  const kept = useRef<ReadonlySet<string>>(new Set());
  useEffect(() => {
    still.current = reducedMotion;
  }, [reducedMotion]);

  /** Writes every position onto its element. This is the whole cost of one frame. */
  const paint = useCallback(() => {
    const current = layout.current;
    const layer = layerRef.current;
    if (!current || !layer) return;
    const scale = stage.scale();
    const close = svgRef.current?.dataset.zoom === "near";
    const names: NameBox[] = [];
    const nameElements: SVGGElement[] = [];
    for (const [key, node] of current.nodes) {
      nodeElements.current.get(key)?.setAttribute("transform", `translate(${node.x},${node.y})`);
    }
    for (const wire of current.wires) {
      const line = linkElements.current.get(wire.key);
      if (!line) continue;
      line.setAttribute("x1", String(wire.source.x));
      line.setAttribute("y1", String(wire.source.y));
      line.setAttribute("x2", String(wire.target.x));
      line.setAttribute("y2", String(wire.target.y));
    }
    // A ring or a name drawn on top of everything goes wherever its node goes.
    for (const follower of layer.querySelectorAll<SVGGElement>("[data-follow]")) {
      const node = current.nodes.get(follower.dataset.follow ?? "");
      if (!node) continue;
      follower.setAttribute("transform", `translate(${node.x},${node.y})`);
      if (follower.hasAttribute("data-floating")) {
        // The name of a dot is drawn above it and is always shown, so it takes its room first.
        names.push({
          key: `floating:${node.key}`,
          x: node.x * scale,
          y: (node.y - node.radius) * scale - NAME_DROP - NAME_LINE / 2,
          width: nameWidth(node.label) + NAME_SPACE,
          height: NAME_LINE,
          rank: 2000,
        });
        continue;
      }
      if (!follower.classList.contains("kmap-name")) continue;
      const first = kept.current.has(node.key);
      const height = close || first ? NAME_TWO_LINES : NAME_LINE;
      nameElements.push(follower);
      names.push({
        key: node.key,
        x: node.x * scale,
        y: (node.y + node.radius) * scale + NAME_DROP + height / 2,
        width: nameWidth(node.label) + NAME_SPACE,
        height,
        rank: (first ? 1000 : 0) + node.radius,
      });
    }
    // Names keep their size while the picture shrinks, so the ones with no room are left out.
    const crowded = crowdedNames(names);
    for (const element of nameElements) {
      element.toggleAttribute("data-crowded", crowded.has(element.dataset.follow ?? ""));
    }
  }, [layerRef, svgRef, stage]);

  useEffect(() => {
    repaint.current = paint;
  }, [paint]);

  const fit = useCallback(
    (animate: boolean) => {
      const box = layout.current?.bounds();
      if (box) stage.show(box, { maxScale: 1.5, animate, whole: true });
    },
    [stage],
  );

  useImperativeHandle(handle, () => ({ fit: () => fit(true), zoomBy: stage.zoomBy }), [fit, stage]);

  // The graph changed: a page opened, a page closed, or this is the first picture.
  useLayoutEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    const first = layout.current === null;
    const svg = svgRef.current;
    const lie: Lie = svg && svg.clientHeight > svg.clientWidth * TALL ? "tall" : "wide";
    const current = layout.current ?? new GraphLayout(saved.recall(lie), lie);
    layout.current = current;
    const added = current.update(graph);

    nodeElements.current = new Map(
      [...layer.querySelectorAll<SVGGElement>("[data-node]")].map((element) => [element.dataset.node ?? "", element]),
    );
    linkElements.current = new Map(
      [...layer.querySelectorAll<SVGLineElement>("[data-link]")].map((element) => [element.dataset.link ?? "", element]),
    );

    // A first picture is worked out in full before it is shown, unless every node came back to
    // a saved place. After that only a real change moves anything: the same graph again is a
    // remount, and the picture is already at rest.
    const changed = settledFor.current !== null && settledFor.current !== graph;
    settledFor.current = graph;
    if (first && added > 0) current.settle();
    else if (changed && still.current) current.settle(REHEAT);
    else if (changed) current.warm(REHEAT, paint);
    paint();
    if (!fitted.current) {
      fitted.current = true;
      fit(false);
    }
    return () => {
      current.stop();
      // Kept on every close, so a second visit starts from the same picture.
      saved.keep(current.lie, current.positions());
    };
  }, [graph, saved, layerRef, svgRef, paint, fit]);

  // A ring and a name appear after the positions were last written, so they are placed here.
  const pointedKey = pointed ? keyOf(pointed) : null;
  const selectedKey = selected ? keyOf(selected) : null;
  useLayoutEffect(() => {
    kept.current = new Set([pointedKey, selectedKey].filter((key): key is string => key !== null));
    paint();
  }, [paint, pointedKey, selectedKey, near]);

  // The stage changed size and the person has not moved the picture: keep all of it in view.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const observer = new ResizeObserver(() => {
      if (!stage.moved()) fit(false);
    });
    observer.observe(svg);
    return () => observer.disconnect();
  }, [svgRef, stage, fit]);

  // The detail panel opened or closed. While the person has not moved the picture, all of it
  // is kept in view beside the panel, so a selection never hides the rest of the graph.
  const fittedInset = useRef(inset);
  useEffect(() => {
    if (fittedInset.current === inset) return;
    fittedInset.current = inset;
    if (!stage.moved()) fit(true);
  }, [inset, stage, fit]);

  // Once the person has moved the picture it stays where they put it, with two exceptions: a
  // search result or a panel link is brought to the middle, and a node selected by a press is
  // moved clear when it sits under the detail panel.
  useEffect(() => {
    if (!focus || !stage.moved()) return;
    const node = layout.current?.nodes.get(keyOf(focus.ref));
    if (node) stage.centreOn(node.x, node.y, FOCUS_SCALE);
  }, [focus, stage]);

  useEffect(() => {
    if (!selectedKey || !stage.moved()) return;
    const node = layout.current?.nodes.get(selectedKey);
    if (node) stage.reveal(node.x, node.y);
  }, [selectedKey, stage, inset]);

  const press = useRef<{ key: string; pointer: number; x: number; y: number; dragging: boolean } | null>(null);

  const refOf = (target: EventTarget | null): GraphNode | null => {
    const key = (target as Element | null)?.closest?.<SVGGElement>("[data-node]")?.dataset.node;
    return key ? (byKey.get(key) ?? null) : null;
  };

  const onPointerDown = (event: React.PointerEvent<SVGGElement>): void => {
    const node = refOf(event.target);
    if (!node || event.button !== 0) return;
    nodeElements.current.get(node.key)?.setPointerCapture(event.pointerId);
    press.current = { key: node.key, pointer: event.pointerId, x: event.clientX, y: event.clientY, dragging: false };
  };

  const onPointerMove = (event: React.PointerEvent<SVGGElement>): void => {
    const held = press.current;
    const current = layout.current;
    if (!held || !current || held.pointer !== event.pointerId) return;
    if (!held.dragging && Math.hypot(event.clientX - held.x, event.clientY - held.y) < DRAG_SLOP) return;
    const node = current.nodes.get(held.key);
    if (!node) return;
    const at = stage.toPicture(event.clientX, event.clientY);
    node.fx = at.x;
    node.fy = at.y;
    if (still.current) {
      // With less motion asked for, only the dragged node moves.
      node.x = at.x;
      node.y = at.y;
      paint();
    } else if (!held.dragging) {
      current.hold(true, paint);
    }
    held.dragging = true;
  };

  const onPointerUp = (event: React.PointerEvent<SVGGElement>): void => {
    const held = press.current;
    if (!held || held.pointer !== event.pointerId) return;
    press.current = null;
    const current = layout.current;
    const node = current?.nodes.get(held.key);
    if (held.dragging) {
      if (node) {
        node.fx = null;
        node.fy = null;
      }
      if (!still.current) current?.hold(false, paint);
      return;
    }
    const pressed = byKey.get(held.key);
    if (pressed && event.type === "pointerup") onSelect({ kind: pressed.kind, id: pressed.id });
  };

  const onPointerOver = (event: React.PointerEvent<SVGGElement>): void => {
    if (press.current?.dragging) return;
    const node = refOf(event.target);
    setHovered((now) => {
      if (!node) return now;
      return now && now.kind === node.kind && now.id === node.id ? now : { kind: node.kind, id: node.id };
    });
  };

  const onPointerOut = (event: React.PointerEvent<SVGGElement>): void => {
    if (press.current?.dragging) return;
    if (!refOf(event.relatedTarget)) setHovered(null);
  };

  const onKeyDown = (event: React.KeyboardEvent<SVGGElement>): void => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const node = refOf(event.target);
    if (!node) return;
    event.preventDefault();
    onSelect({ kind: node.kind, id: node.id });
  };

  const selectedNode = selectedKey ? byKey.get(selectedKey) : undefined;
  const pointedNode = pointedKey ? byKey.get(pointedKey) : undefined;
  // A source and a page always carry their name. A passage and a control carry it only while
  // pointed at or selected, and it is drawn above everything so a neighbour never covers it.
  const floating = [pointedNode, selectedNode].filter(
    (node, at, all): node is GraphNode =>
      node !== undefined && (node.kind === "passage" || node.kind === "control") && all.indexOf(node) === at,
  );

  return (
    <svg
      ref={svgRef}
      className={`kmap-svg${lit ? " has-focus" : ""}`}
      role="group"
      aria-label="Knowledge graph. Use the search box to find a node, then the detail panel to move between nodes."
      onClick={(event) => {
        if (!(event.target as Element).closest("[data-node]")) onSelect(null);
      }}
    >
      <g ref={layerRef}>
        <g className="kmap-links">
          {graph.links.map((link) => (
            <LinkLine key={link.key} link={link} lit={lit?.links.has(link.key) ?? false} />
          ))}
        </g>
        <g
          className="kmap-nodes"
          data-movable=""
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onPointerOver={onPointerOver}
          onPointerOut={onPointerOut}
          onKeyDown={onKeyDown}
        >
          {drawn.map((node) => (
            <NodeGlyph
              key={node.key}
              node={node}
              lit={lit?.nodes.has(node.key) ?? false}
              selected={node.key === selectedKey}
              near={nearKeys.has(node.key)}
            />
          ))}
        </g>
        <g className="kmap-names" data-scale="">
          {graph.nodes
            .filter((node) => node.kind === "source" || node.kind === "page")
            .map((node) => (
              <NameGlyph
                key={node.key}
                node={node}
                lit={lit?.nodes.has(node.key) ?? false}
                pointed={node.key === pointedKey}
                selected={node.key === selectedKey}
              />
            ))}
        </g>
        <g className="kmap-top" data-scale="">
          {graph.nodes
            .filter((node) => nearKeys.has(node.key))
            .map((node) => (
              <g key={`near-${node.key}`} className="kmap-ring is-near" data-follow={node.key}>
                <NodeRing kind={node.kind} radius={node.radius} gap={2.6} />
              </g>
            ))}
          {selectedNode ? (
            <g className="kmap-ring" data-follow={selectedNode.key}>
              <NodeRing kind={selectedNode.kind} radius={selectedNode.radius} gap={selectedNode.kind === "source" ? 6 : 3.4} />
            </g>
          ) : null}
          {floating.map((node) => (
            <g
              key={`name-${node.key}`}
              data-follow={node.key}
              data-floating=""
              style={{ "--r": node.radius } as React.CSSProperties}
            >
              <text className="kmap-label is-floating" textAnchor="middle">
                {node.label}
              </text>
            </g>
          ))}
        </g>
      </g>
    </svg>
  );
}
