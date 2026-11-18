"use client";

import { select } from "d3-selection";
import "d3-transition";
import { zoom, zoomIdentity, type ZoomBehavior, type ZoomTransform } from "d3-zoom";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, type RefObject } from "react";

/** A rectangle in the picture's own coordinates. */
export type Box = { x0: number; y0: number; x1: number; y1: number };

/** How much of each edge of the stage something else covers: the search bar, the detail panel. */
export type Inset = { top: number; right: number; bottom: number; left: number };

export type Stage = {
  /** A point on the screen, in the picture's coordinates. */
  toPicture: (clientX: number, clientY: number) => { x: number; y: number };
  /**
   * Fits a box into the part of the stage nothing covers. `whole` says the box is the whole
   * picture: from then on the picture counts as not moved, until the person moves it again.
   */
  show: (box: Box, options?: { maxScale?: number; animate?: boolean; whole?: boolean }) => void;
  /** Brings one point to the middle, at least this close. */
  centreOn: (x: number, y: number, minScale: number) => void;
  /** Brings a point to the middle when it is under a panel or too near an edge to read around. */
  reveal: (x: number, y: number) => void;
  zoomBy: (factor: number) => void;
  /**
   * True once the person has moved the picture. Until then the whole picture is kept in view for
   * them, whatever opens beside it; after that the picture stays where they put it.
   */
  moved: () => boolean;
  /** The current zoom scale. */
  scale: () => number;
};

const MIN_SCALE = 0.2;
const MAX_SCALE = 8;
/** How long the picture takes to travel to a node. */
const TRAVEL_MS = 520;
/** Room kept between a node and the edge of the free area. */
const MARGIN = 26;
/** A selected node this near the edge of the free area is brought to the middle of it. */
const CLEAR_EDGE = 90;
/** From this scale on the picture counts as close, and a view may show its finer text. */
const NEAR_SCALE = 1.2;

/**
 * Zoom and pan for one SVG stage: wheel and pinch zoom, drag pans, on mouse, trackpad and touch.
 *
 * The transform is written straight onto the layer, never through React state, so a drag costs
 * one attribute per frame. The scale is also published as `--k`, which is what lets a name keep
 * its size on screen while the picture grows under it. It is written only onto the layers marked
 * `data-scale`, the ones that hold names: a custom property is inherited, so writing it on the
 * SVG would restyle every node on every frame of a zoom.
 */
export function useZoomPan(
  reducedMotion: boolean,
  inset: Inset,
  /** Called with the new scale each time the scale changes. A pan does not call it. */
  onScale?: (scale: number) => void,
): { svgRef: RefObject<SVGSVGElement | null>; layerRef: RefObject<SVGGElement | null>; stage: Stage } {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const layerRef = useRef<SVGGElement | null>(null);
  const behaviour = useRef<ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const current = useRef<ZoomTransform>(zoomIdentity);
  const touched = useRef(false);
  const still = useRef(reducedMotion);
  const covered = useRef(inset);
  const scaled = useRef(onScale);

  useEffect(() => {
    still.current = reducedMotion;
    covered.current = inset;
    scaled.current = onScale;
  }, [reducedMotion, inset, onScale]);

  // A layout effect, so the behaviour exists before a view asks for its first fit.
  useLayoutEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const created = zoom<SVGSVGElement, unknown>()
      .scaleExtent([MIN_SCALE, MAX_SCALE])
      // The wheel always zooms and a drag pans, with one exception: where nodes can be moved
      // (a layer marked `data-movable`), a drag that starts on a node moves that node.
      .filter((event: Event) => {
        if (event.type === "wheel") return true;
        if ((event as MouseEvent).button) return false;
        return !(event.target as Element | null)?.closest?.("[data-movable] [data-node]");
      })
      .on("zoom", (event: { transform: ZoomTransform; sourceEvent: Event | null }) => {
        const rescaled = event.transform.k !== current.current.k;
        current.current = event.transform;
        if (event.sourceEvent) touched.current = true;
        layerRef.current?.setAttribute("transform", event.transform.toString());
        const scale = String(event.transform.k);
        for (const scaled of svg.querySelectorAll<SVGElement>("[data-scale]")) scaled.style.setProperty("--k", scale);
        // Written only when it changes: this is what lets a view show more once it is close.
        const zoom = event.transform.k >= NEAR_SCALE ? "near" : "far";
        if (svg.dataset.zoom !== zoom) svg.dataset.zoom = zoom;
        if (rescaled) scaled.current?.(event.transform.k);
      });
    behaviour.current = created;
    const selection = select(svg);
    selection.call(created).on("dblclick.zoom", null);
    return () => {
      selection.interrupt();
      selection.on(".zoom", null);
      behaviour.current = null;
    };
  }, []);

  const apply = useCallback((target: ZoomTransform, animate: boolean) => {
    const svg = svgRef.current;
    const zoomer = behaviour.current;
    if (!svg || !zoomer) return;
    const selection = select(svg);
    if (animate && !still.current) selection.transition().duration(TRAVEL_MS).call(zoomer.transform, target);
    else selection.interrupt().call(zoomer.transform, target);
  }, []);

  /** The part of the stage nothing covers, in screen pixels relative to the SVG. */
  const freeArea = useCallback((): { x: number; y: number; width: number; height: number } => {
    const svg = svgRef.current;
    const width = svg?.clientWidth ?? 0;
    const height = svg?.clientHeight ?? 0;
    const edge = covered.current;
    return {
      x: edge.left,
      y: edge.top,
      width: Math.max(1, width - edge.left - edge.right),
      height: Math.max(1, height - edge.top - edge.bottom),
    };
  }, []);

  const stage = useMemo<Stage>(
    () => ({
      moved: () => touched.current,
      scale: () => current.current.k,
      toPicture: (clientX, clientY) => {
        const rect = svgRef.current?.getBoundingClientRect();
        const [x, y] = current.current.invert([clientX - (rect?.left ?? 0), clientY - (rect?.top ?? 0)]);
        return { x, y };
      },
      show: (box, options) => {
        if (options?.whole) touched.current = false;
        const area = freeArea();
        const width = Math.max(1, box.x1 - box.x0);
        const height = Math.max(1, box.y1 - box.y0);
        const scale = Math.min(
          options?.maxScale ?? MAX_SCALE,
          Math.max(MIN_SCALE, Math.min((area.width - MARGIN * 2) / width, (area.height - MARGIN * 2) / height)),
        );
        const target = zoomIdentity
          .translate(area.x + area.width / 2, area.y + area.height / 2)
          .scale(scale)
          .translate(-(box.x0 + box.x1) / 2, -(box.y0 + box.y1) / 2);
        apply(target, options?.animate ?? true);
      },
      centreOn: (x, y, minScale) => {
        const area = freeArea();
        const scale = Math.max(current.current.k, minScale);
        apply(
          zoomIdentity.translate(area.x + area.width / 2, area.y + area.height / 2).scale(scale).translate(-x, -y),
          true,
        );
      },
      reveal: (x, y) => {
        const area = freeArea();
        const now = current.current;
        const [screenX, screenY] = now.apply([x, y]);
        const edgeX = Math.min(CLEAR_EDGE, area.width / 4);
        const edgeY = Math.min(CLEAR_EDGE, area.height / 4);
        const clear =
          screenX >= area.x + edgeX &&
          screenX <= area.x + area.width - edgeX &&
          screenY >= area.y + edgeY &&
          screenY <= area.y + area.height - edgeY;
        if (clear) return;
        apply(
          zoomIdentity.translate(area.x + area.width / 2, area.y + area.height / 2).scale(now.k).translate(-x, -y),
          true,
        );
      },
      zoomBy: (factor) => {
        const area = freeArea();
        const now = current.current;
        const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, now.k * factor));
        const centre: [number, number] = [area.x + area.width / 2, area.y + area.height / 2];
        const [x, y] = now.invert(centre);
        touched.current = true;
        apply(zoomIdentity.translate(centre[0], centre[1]).scale(scale).translate(-x, -y), true);
      },
    }),
    [apply, freeArea],
  );
  // The two refs are handed back on their own: a view puts them on its elements while it renders.
  return { svgRef, layerRef, stage };
}
