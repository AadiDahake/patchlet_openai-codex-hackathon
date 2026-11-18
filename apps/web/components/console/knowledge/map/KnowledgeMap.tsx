"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { indexMap, type MapIndex, type NodeRef } from "@/lib/knowledge/graph";
import type { Lie, Point } from "@/lib/knowledge/layout";
import type { KnowledgeMap as MapData, NearPassage, VectorLayout } from "@/lib/knowledge/types";
import { DetailPanel, type NearState } from "./DetailPanel";
import { GraphView, type FocusRequest, type SavedLayout, type ViewHandle } from "./GraphView";
import { GraphLegend, VectorLegend } from "./MapLegend";
import { MapSearch } from "./MapSearch";
import { useMediaQuery, useReducedMotion } from "./useMediaQuery";
import type { Inset } from "./useZoomPan";
import { VectorView } from "./VectorView";

export type MapView = "graph" | "vectors";

type Props = {
  view: MapView;
  onView: (view: MapView) => void;
  /** Goes back to the list of sources, where knowledge is added. */
  onAddSources: () => void;
};

type Loaded<T> = { status: "loading" } | { status: "ready"; value: T } | { status: "error"; message: string };

/** Room the search bar takes at the top of the stage. */
const BAR = 62;
/** The legend's height on one line, and the gap under it. It grows to two lines beside the panel. */
const LEGEND_LINE = 38;
const GAP = 12;
/** The detail panel's width and its gap, on a stage wide enough to hold it beside the picture. */
const PANEL = 372;
const WIDE = "(min-width: 900px)";

async function read<T>(url: string, field: string, fallback: string): Promise<T> {
  const response = await fetch(url);
  const body = (await response.json()) as Record<string, unknown>;
  if (!response.ok || body[field] === undefined) {
    throw new Error(typeof body.error === "string" ? body.error : fallback);
  }
  return body[field] as T;
}

const NO_NEAR: readonly NearPassage[] = [];

/** The picture of what the agent knows: a graph of the stored links, and the vector store as points. */
export function KnowledgeMap({ view, onView, onAddSources }: Props) {
  const [map, setMap] = useState<Loaded<MapIndex>>({ status: "loading" });
  const [vectors, setVectors] = useState<Loaded<VectorLayout>>({ status: "loading" });
  const [selected, setSelected] = useState<NodeRef | null>(null);
  const [hinted, setHinted] = useState<NodeRef | null>(null);
  const [focus, setFocus] = useState<FocusRequest | null>(null);
  const [near, setNear] = useState<{ forId: string; state: NearState } | null>(null);
  const positions = useRef<{ lie: Lie; points: Map<string, Point> } | null>(null);
  const saved = useMemo<SavedLayout>(
    () => ({
      recall: (lie) => (positions.current?.lie === lie ? positions.current.points : new Map()),
      keep: (lie, points) => {
        positions.current = { lie, points };
      },
    }),
    [],
  );
  const handle = useRef<ViewHandle | null>(null);
  const focusCount = useRef(0);
  const reducedMotion = useReducedMotion();
  const wide = useMediaQuery(WIDE);

  useEffect(() => {
    let live = true;
    read<MapData>("/api/knowledge/map", "map", "The knowledge graph could not be read.")
      .then((data) => live && setMap({ status: "ready", value: indexMap(data) }))
      .catch((failure: Error) => live && setMap({ status: "error", message: failure.message }));
    return () => {
      live = false;
    };
  }, []);

  // The stored vectors are only read when someone opens the view that draws them.
  const wantsVectors = view === "vectors";
  useEffect(() => {
    if (!wantsVectors) return;
    let live = true;
    read<VectorLayout>("/api/knowledge/vectors", "layout", "The vector store could not be read.")
      .then((layout) => live && setVectors({ status: "ready", value: layout }))
      .catch((failure: Error) => live && setVectors({ status: "error", message: failure.message }));
    return () => {
      live = false;
    };
  }, [wantsVectors]);

  // The vector view has no page and no control to show, so such a selection waits in the graph.
  const shown =
    view === "vectors" && selected && (selected.kind === "page" || selected.kind === "control") ? null : selected;

  const passageId = shown?.kind === "passage" ? shown.id : null;
  useEffect(() => {
    if (!passageId) return;
    let live = true;
    read<NearPassage[]>(
      `/api/knowledge/neighbours?passage=${encodeURIComponent(passageId)}`,
      "near",
      "The nearest passages could not be read.",
    )
      .then((items) => live && setNear({ forId: passageId, state: { status: "ready", items } }))
      .catch(
        (failure: Error) =>
          live && setNear({ forId: passageId, state: { status: "error", message: failure.message } }),
      );
    return () => {
      live = false;
    };
  }, [passageId]);

  const nearState: NearState = near && near.forId === passageId ? near.state : { status: "loading" };
  const nearItems = passageId && nearState.status === "ready" ? nearState.items : NO_NEAR;
  const nearIds = useMemo(() => nearItems.map((entry) => entry.id), [nearItems]);

  const select = useCallback((ref: NodeRef | null) => {
    setSelected(ref);
    setHinted(null);
  }, []);

  /** Selects a node from outside the picture and brings it to the middle. */
  const jump = useCallback(
    (ref: NodeRef) => {
      setSelected(ref);
      setHinted(null);
      focusCount.current += 1;
      setFocus({ ref, token: focusCount.current });
      if (view === "vectors" && (ref.kind === "page" || ref.kind === "control")) onView("graph");
    },
    [view, onView],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && !(event.target instanceof HTMLInputElement)) setSelected(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // The legend lies over the bottom of the stage and wraps when the panel takes its room, so
  // its real height is what the picture has to stay clear of.
  const [legendHeight, setLegendHeight] = useState(LEGEND_LINE);
  const watchLegend = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    const observer = new ResizeObserver(() => setLegendHeight(Math.round(node.getBoundingClientRect().height)));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const panelOpen = shown !== null;
  const inset = useMemo<Inset>(
    () => ({ top: BAR, right: wide && panelOpen ? PANEL : 0, bottom: wide ? legendHeight + GAP : GAP, left: 0 }),
    [wide, panelOpen, legendHeight],
  );

  if (map.status === "loading") {
    return (
      <div className="kmap is-waiting" role="status">
        <p>Reading what the agent knows...</p>
      </div>
    );
  }
  if (map.status === "error") {
    return (
      <div className="notice is-error" role="alert">
        {map.message}
      </div>
    );
  }

  const index = map.value;
  const data = index.map;
  const nothingKnown = data.sources.length === 0 && data.pages.length === 0;
  const noPassages = view === "vectors" && data.passages.length === 0;

  if (nothingKnown || noPassages) {
    return (
      <div className="empty-state kmap-empty">
        <p className="empty-state__title">{nothingKnown ? "Nothing to draw yet" : "No passages yet"}</p>
        <p className="empty-state__text">
          {nothingKnown
            ? "The agent has no sources and has seen no pages. Add a source and the graph draws itself."
            : "The vector store is empty. Add a source and each passage read from it becomes a point."}
        </p>
        <button type="button" className="secondary-action mt-3" onClick={onAddSources}>
          Add a source
        </button>
      </div>
    );
  }

  const legend =
    view === "graph" ? (
      <GraphLegend map={data} />
    ) : vectors.status === "ready" ? (
      <VectorLegend layout={vectors.value} drawn={vectors.value.points.length} />
    ) : null;

  return (
    <div className={`kmap${panelOpen ? " has-detail" : ""}`}>
      <div className="kmap__stage">
        {view === "graph" ? (
          <GraphView
            index={index}
            selected={shown}
            hinted={hinted}
            near={nearIds}
            focus={focus}
            saved={saved}
            reducedMotion={reducedMotion}
            inset={inset}
            onSelect={select}
            handle={handle}
          />
        ) : vectors.status === "ready" ? (
          <VectorView
            index={index}
            layout={vectors.value}
            selected={shown}
            hinted={hinted}
            near={nearItems}
            focus={focus}
            reducedMotion={reducedMotion}
            inset={inset}
            onSelect={select}
            handle={handle}
          />
        ) : (
          <div className="kmap__waiting" role={vectors.status === "error" ? "alert" : "status"}>
            <p>{vectors.status === "error" ? vectors.message : "Laying out the vector store..."}</p>
          </div>
        )}

        <div className="kmap__bar">
          <MapSearch index={index} onPick={jump} onHint={setHinted} />
          <div className="kmap__zoom" role="group" aria-label="Zoom">
            <button type="button" onClick={() => handle.current?.zoomBy(1 / 1.4)} aria-label="Zoom out">
              <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
                <path d="M3 7h8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            </button>
            <button type="button" onClick={() => handle.current?.zoomBy(1.4)} aria-label="Zoom in">
              <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
                <path d="M3 7h8M7 3v8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            </button>
            <button type="button" className="kmap__fit" onClick={() => handle.current?.fit()}>
              Fit
            </button>
          </div>
          <p className="kmap__hint">
            {view === "graph"
              ? "Scroll to zoom. Drag to move. Select a page to open its controls."
              : "Scroll to zoom. Drag to move. Select a passage to see what is nearest."}
          </p>
        </div>
      </div>

      {/* Over the stage on a wide screen, under it on a narrow one: see `.kmap__foot`. */}
      <div className="kmap__foot" ref={watchLegend}>
        {legend}
      </div>

      {shown ? (
        <DetailPanel
          index={index}
          selected={shown}
          near={nearState}
          onJump={jump}
          onHint={setHinted}
          onClose={() => select(null)}
        />
      ) : null}
    </div>
  );
}
