"use client";

import { useId, useMemo, useState } from "react";
import type { MapIndex, NodeRef } from "@/lib/knowledge/graph";
import { searchNodes } from "@/lib/knowledge/search";
import { NodeMark } from "./NodeMark";

type Props = {
  index: MapIndex;
  /** Selects the node and brings it to the middle of the picture. */
  onPick: (ref: NodeRef) => void;
  onHint: (ref: NodeRef | null) => void;
};

/** Finds a node by its name or, for a passage, by its text. Arrow keys move, Enter goes there. */
export function MapSearch({ index, onPick, onHint }: Props) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();
  const hits = useMemo(() => searchNodes(index, query), [index, query]);
  const showing = open && query.trim() !== "";
  const current = hits[Math.min(active, hits.length - 1)];

  const pick = (hit: NodeRef): void => {
    onHint(null);
    onPick({ kind: hit.kind, id: hit.id });
    setOpen(false);
  };

  const move = (step: number): void => {
    if (hits.length === 0) return;
    const next = (Math.min(active, hits.length - 1) + step + hits.length) % hits.length;
    setActive(next);
    const hit = hits[next];
    if (hit) onHint({ kind: hit.kind, id: hit.id });
  };

  return (
    <div className="kmap-search" role="search">
      <svg className="kmap-search__icon" width="15" height="15" viewBox="0 0 15 15" aria-hidden="true">
        <circle cx="6.5" cy="6.5" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M10 10l3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
      <input
        className="field-input kmap-search__input"
        type="search"
        role="combobox"
        aria-label="Find a source, a passage, a page or a control"
        aria-expanded={showing}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={showing && current ? `${listId}-${current.kind}-${current.id}` : undefined}
        placeholder="Find a source, passage, page or control"
        autoComplete="off"
        spellCheck={false}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          setOpen(false);
          onHint(null);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setOpen(true);
            move(1);
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            move(-1);
          } else if (event.key === "Enter" && showing && current) {
            event.preventDefault();
            pick(current);
          } else if (event.key === "Escape") {
            setOpen(false);
            onHint(null);
          }
        }}
      />
      {showing ? (
        <div className="kmap-search__menu">
          {hits.length === 0 ? (
            <p className="kmap-search__none" id={listId} role="status">
              Nothing the agent knows matches that.
            </p>
          ) : (
            <ul className="kmap-search__list" id={listId} role="listbox" aria-label="Matches">
              {hits.map((hit, at) => (
                <li
                  key={`${hit.kind}-${hit.id}`}
                  id={`${listId}-${hit.kind}-${hit.id}`}
                  role="option"
                  aria-selected={hit === current}
                  className={`kmap-search__hit${hit === current ? " is-active" : ""}`}
                  // The press must not take focus from the input, or the list closes before the click lands.
                  onPointerDown={(event) => event.preventDefault()}
                  onPointerEnter={() => {
                    setActive(at);
                    onHint({ kind: hit.kind, id: hit.id });
                  }}
                  onClick={() => pick(hit)}
                >
                  <NodeMark kind={hit.kind} />
                  <span className="kmap-search__label">{hit.label}</span>
                  <span className="kmap-search__context">{hit.context}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
