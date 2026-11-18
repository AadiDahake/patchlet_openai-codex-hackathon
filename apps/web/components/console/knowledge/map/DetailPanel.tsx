"use client";

import type { ReactNode } from "react";
import { plural, type MapIndex, type NodeKind, type NodeRef } from "@/lib/knowledge/graph";
import type { NearPassage } from "@/lib/knowledge/types";
import { NodeMark } from "./NodeMark";

/** The nearest passages of the selected passage, as far as the request for them has got. */
export type NearState =
  | { status: "loading" }
  | { status: "ready"; items: readonly NearPassage[] }
  | { status: "error"; message: string };

type Props = {
  index: MapIndex;
  selected: NodeRef;
  near: NearState;
  /** Selects another node and brings it to the middle of the picture. */
  onJump: (ref: NodeRef) => void;
  /** Lights a node up in the picture while its row is pointed at. */
  onHint: (ref: NodeRef | null) => void;
  onClose: () => void;
};

const KIND_NAME: Record<NodeKind, string> = {
  source: "Source",
  passage: "Passage",
  page: "Page",
  control: "Control",
};

/** How the stored source kind reads, in the words the Sources list uses. */
const SOURCE_KIND: Record<string, string> = { text: "Written", url: "Web page", upload: "File" };

function confidence(value: number | null): string {
  return value === null ? "Not scanned (read as text)" : value.toFixed(2);
}

function Fact({ label, wide, children }: { label: string; wide?: boolean; children: ReactNode }) {
  return (
    <div className={`kmap-fact${wide ? " is-wide" : ""}`}>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function Section({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className="kmap-detail__section">
      <h4 className="kmap-detail__heading">
        {title}
        {note ? <span>{note}</span> : null}
      </h4>
      {children}
    </section>
  );
}

/** The detail of whatever is selected, with every related node one press away. */
export function DetailPanel({ index, selected, near, onJump, onHint, onClose }: Props) {
  /** A row that names another node: pressing it goes there, pointing at it lights it up. */
  const jump = (ref: NodeRef, label: string, aside?: string, lead?: string): ReactNode => (
    <button
      type="button"
      className="kmap-jump"
      onClick={() => onJump(ref)}
      onPointerEnter={() => onHint(ref)}
      onPointerLeave={() => onHint(null)}
      onFocus={() => onHint(ref)}
      onBlur={() => onHint(null)}
    >
      <NodeMark kind={ref.kind} />
      {lead ? <span className="kmap-jump__lead">{lead}</span> : null}
      <span className="kmap-jump__label">{label}</span>
      {aside ? <span className="kmap-jump__aside">{aside}</span> : null}
    </button>
  );

  const list = (rows: { key: string; row: ReactNode }[]): ReactNode => (
    <ul className="kmap-jumps">
      {rows.map((entry) => (
        <li key={entry.key}>{entry.row}</li>
      ))}
    </ul>
  );

  let title = "";
  let body: ReactNode = null;

  if (selected.kind === "passage") {
    const passage = index.passages.get(selected.id);
    if (!passage) return null;
    const source = index.sources.get(passage.sourceId);
    const page = passage.readFrom ? index.pages.get(passage.readFrom) : undefined;
    title = passage.label;
    body = (
      <>
        <dl className="kmap-facts">
          {source ? <Fact label="Source">{jump({ kind: "source", id: source.id }, source.title)}</Fact> : null}
          {page ? <Fact label="Read from">{jump({ kind: "page", id: page.route }, page.label)}</Fact> : null}
          {passage.page !== null && (source?.pageCount ?? 0) > 1 ? (
            <Fact label="Page in source">{passage.page}</Fact>
          ) : null}
          <Fact label="Reading confidence">{confidence(passage.confidence)}</Fact>
        </dl>
        <Section title="Text">
          <p className="kmap-detail__text">{passage.text}</p>
        </Section>
        <Section title="Nearest passages" note="pgvector, cosine similarity">
          {near.status === "loading" ? <p className="kmap-detail__note">Asking the vector store...</p> : null}
          {near.status === "error" ? <p className="kmap-detail__note is-error">{near.message}</p> : null}
          {near.status === "ready" && near.items.length === 0 ? (
            <p className="kmap-detail__note">This is the only passage in the store.</p>
          ) : null}
          {near.status === "ready"
            ? list(
                near.items.flatMap((entry) => {
                  const other = index.passages.get(entry.id);
                  if (!other) return [];
                  return [
                    {
                      key: entry.id,
                      row: jump(
                        { kind: "passage", id: other.id },
                        other.label,
                        index.sources.get(other.sourceId)?.title,
                        entry.similarity.toFixed(3),
                      ),
                    },
                  ];
                }),
              )
            : null}
        </Section>
      </>
    );
  } else if (selected.kind === "source") {
    const source = index.sources.get(selected.id);
    if (!source) return null;
    const passages = index.passagesBySource.get(source.id) ?? [];
    const readFrom = index.map.readLinks.filter((link) => link.sourceId === source.id);
    title = source.title;
    body = (
      <>
        <dl className="kmap-facts">
          <Fact label="Kind">{SOURCE_KIND[source.kind] ?? source.kind}</Fact>
          <Fact label="Status">{source.status}</Fact>
          {source.address ? (
            <Fact label="Address" wide>
              <span className="mono">{source.address}</span>
            </Fact>
          ) : null}
          <Fact label="Passages">{source.passageCount.toLocaleString("en-US")}</Fact>
          <Fact label="Reading confidence">{confidence(source.meanConfidence)}</Fact>
        </dl>
        {readFrom.length > 0 ? (
          <Section title="Read from" note={plural(readFrom.length, "page")}>
            {list(
              readFrom.map((link) => ({
                key: link.route,
                row: jump(
                  { kind: "page", id: link.route },
                  index.pages.get(link.route)?.label ?? link.route,
                  plural(link.passages, "passage"),
                ),
              })),
            )}
          </Section>
        ) : null}
        {passages.length > 0 ? (
          <Section title="Passages" note={String(passages.length)}>
            {list(passages.map((passage) => ({ key: passage.id, row: jump({ kind: "passage", id: passage.id }, passage.label) })))}
          </Section>
        ) : null}
      </>
    );
  } else if (selected.kind === "page") {
    const page = index.pages.get(selected.id);
    if (!page) return null;
    const controls = index.controlsByRoute.get(page.route) ?? [];
    const leadsTo = index.map.moves.filter((move) => move.from === page.route);
    const readInto = index.map.readLinks.filter((link) => link.route === page.route);
    title = page.title || page.route;
    body = (
      <>
        <dl className="kmap-facts">
          <Fact label="Route" wide>
            <span className="mono">{page.route}</span>
          </Fact>
          <Fact label="Controls">{page.controlCount.toLocaleString("en-US")}</Fact>
        </dl>
        {readInto.length > 0 ? (
          <Section title="Sources read from this page">
            {list(
              readInto.map((link) => ({
                key: link.sourceId,
                row: jump(
                  { kind: "source", id: link.sourceId },
                  index.sources.get(link.sourceId)?.title ?? "Source",
                  plural(link.passages, "passage"),
                ),
              })),
            )}
          </Section>
        ) : null}
        {leadsTo.length > 0 ? (
          <Section title="Leads to" note={plural(leadsTo.length, "page")}>
            {list(
              leadsTo.map((move) => ({
                key: move.to,
                row: jump(
                  { kind: "page", id: move.to },
                  index.pages.get(move.to)?.label ?? move.to,
                  plural(move.count, "transition"),
                ),
              })),
            )}
          </Section>
        ) : null}
        {controls.length > 0 ? (
          <Section title="Controls" note={String(controls.length)}>
            {list(
              controls.map((control) => ({
                key: control.id,
                row: jump({ kind: "control", id: control.id }, control.name, control.landmark ?? undefined, control.role),
              })),
            )}
          </Section>
        ) : null}
      </>
    );
  } else {
    const control = index.controls.get(selected.id);
    if (!control) return null;
    const page = index.pages.get(control.route);
    const links = index.map.controlLinks.filter((link) => link.controlId === control.id);
    const opens = [...new Set(links.flatMap((link) => (link.toRoute ? [link.toRoute] : [])))];
    const reveals = [...new Set(links.flatMap((link) => (link.revealsControlId ? [link.revealsControlId] : [])))];
    title = control.name;
    body = (
      <>
        <dl className="kmap-facts">
          <Fact label="Role">{control.role}</Fact>
          <Fact label="Name" wide>
            {control.name}
          </Fact>
          {control.landmark ? <Fact label="Inside">{control.landmark}</Fact> : null}
          {control.href ? (
            <Fact label="Link target" wide>
              <span className="mono">{control.href}</span>
            </Fact>
          ) : null}
          {page ? <Fact label="On page">{jump({ kind: "page", id: page.route }, page.label)}</Fact> : null}
        </dl>
        {opens.length > 0 ? (
          <Section title="Opens">
            {list(
              opens.map((route) => ({
                key: route,
                row: jump({ kind: "page", id: route }, index.pages.get(route)?.label ?? route),
              })),
            )}
          </Section>
        ) : null}
        {reveals.length > 0 ? (
          <Section title="Reveals">
            {list(
              reveals.map((id) => ({
                key: id,
                row: jump({ kind: "control", id }, index.controls.get(id)?.name ?? "Control"),
              })),
            )}
          </Section>
        ) : null}
      </>
    );
  }

  return (
    <aside className="kmap-detail" aria-label={`${KIND_NAME[selected.kind]} details`}>
      <header className="kmap-detail__head">
        <span className="kmap-detail__kind">
          <NodeMark kind={selected.kind} />
          {KIND_NAME[selected.kind]}
        </span>
        <button type="button" className="kmap-detail__close" onClick={onClose} aria-label="Close details">
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <path d="M3 3l8 8M11 3l-8 8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
        <h3 className="kmap-detail__title">{title}</h3>
      </header>
      {/* Keyed, so a new selection starts at the top instead of where the last one was scrolled to. */}
      <div className="kmap-detail__body" key={`${selected.kind}:${selected.id}`}>
        {body}
      </div>
    </aside>
  );
}
