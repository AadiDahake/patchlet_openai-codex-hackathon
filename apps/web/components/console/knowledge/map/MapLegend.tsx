import type { KnowledgeMap, VectorLayout } from "@/lib/knowledge/types";
import { NodeMark } from "./NodeMark";

const count = (value: number): string => value.toLocaleString("en-US");

/** A short sample of a line, for the kinds of link that need naming. */
function LineMark({ kind }: { kind: "read" | "move" | "mesh" }) {
  return (
    <svg className="kmap-mark" width="22" height="16" viewBox="0 0 22 16" aria-hidden="true">
      <line className={`kmap-link is-${kind} is-sample`} x1="1" y1="8" x2="21" y2="8" />
    </svg>
  );
}

/**
 * Names every kind of node and line in the graph, with the totals the Knowledge and Product map
 * pages state for the same things.
 */
export function GraphLegend({ map }: { map: KnowledgeMap }) {
  const { totals } = map;
  return (
    <ul className="kmap-legend" aria-label="What the graph shows">
      <li>
        <NodeMark kind="source" />
        <strong>{count(totals.sources)}</strong> {totals.sources === 1 ? "source" : "sources"}
      </li>
      <li>
        <NodeMark kind="passage" />
        <strong>{count(totals.passages)}</strong> {totals.passages === 1 ? "passage" : "passages"}
      </li>
      <li>
        <NodeMark kind="page" />
        <strong>{count(totals.pages)}</strong> {totals.pages === 1 ? "page" : "pages"}
      </li>
      <li>
        <NodeMark kind="control" />
        <strong>{count(totals.controls)}</strong> {totals.controls === 1 ? "control" : "controls"}
      </li>
      <li>
        <LineMark kind="move" />
        <strong>{count(totals.transitions)}</strong> {totals.transitions === 1 ? "transition" : "transitions"}
      </li>
      {map.readLinks.length > 0 ? (
        <li>
          <LineMark kind="read" />
          read from
        </li>
      ) : null}
    </ul>
  );
}

/** Names what a point and a line are, and says in numbers how true the flat picture is. */
export function VectorLegend({ layout, drawn }: { layout: VectorLayout; drawn: number }) {
  return (
    <ul className="kmap-legend" aria-label="What the vector view shows">
      <li>
        <NodeMark kind="passage" />
        <strong>{count(layout.total)}</strong> {layout.total === 1 ? "passage" : "passages"}
      </li>
      <li>
        <strong>{count(layout.dimensions)}</strong> dimensions each
      </li>
      <li>
        <LineMark kind="mesh" />
        its <strong>{layout.neighbours}</strong> nearest passages
      </li>
      <li title="The share of every passage's nearest passages that are also its nearest points on this flat picture.">
        <strong>{Math.round(layout.kept * 100)}%</strong> of neighbours kept in 2-D
      </li>
      {drawn < layout.total ? (
        <li>
          the first <strong>{count(drawn)}</strong> are drawn
        </li>
      ) : null}
    </ul>
  );
}
