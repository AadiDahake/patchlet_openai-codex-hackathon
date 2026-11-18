/**
 * A small project in the shape of NovaAir: an article read from a developer's machine, a whole
 * site read from the live address, and a product map whose header links everywhere.
 */
import type { StoredGraph } from "@/lib/graph/store";
import type { ConsoleDocument } from "@/lib/ingest/types";
import { indexMap, type MapIndex } from "@/lib/knowledge/graph";
import { shapeKnowledgeMap, type PassageRow } from "@/lib/knowledge/shape";

const SITE = "https://novaair.vercel.app";
const SEEN = "2026-08-30T00:00:00Z";

function document(id: string, title: string, sourceRef: string | null, chunkCount: number): ConsoleDocument {
  return {
    id,
    title,
    sourceKind: sourceRef ? "url" : "text",
    sourceRef,
    mime: sourceRef ? "text/html" : null,
    status: "ready",
    pageCount: sourceRef ? 1 : null,
    meanConfidence: null,
    chunkCount,
    error: null,
    createdAt: SEEN,
    storagePath: null,
  };
}

export const documents: ConsoleDocument[] = [
  document("doc-article", "Check-in", "http://localhost:4100/help/check-in", 2),
  document("doc-site", "Every seat, in plain sight.", `${SITE}/`, 3),
  document("doc-note", "Escalation notes", null, 1),
];

function passage(
  id: string,
  documentId: string,
  ordinal: number,
  heading: string | null,
  content: string,
  sourceRef: string | null,
): PassageRow {
  return { id, documentId, ordinal, heading, content, page: 1, confidence: null, sourceRef };
}

export const passages: PassageRow[] = [
  passage("p-article-1", "doc-article", 0, "When to check in", "Check-in opens 24 hours before departure.", "http://localhost:4100/help/check-in"),
  passage("p-article-2", "doc-article", 1, "At the airport", "Bag drop closes 45 minutes before departure.", "http://localhost:4100/help/check-in"),
  passage("p-site-1", "doc-site", 0, "Every seat, in plain sight.", "Pick the exact seat you will sit in.", `${SITE}/`),
  passage("p-site-2", "doc-site", 1, "When to check in", "Check-in opens 24 hours before departure.", `${SITE}/help/check-in`),
  passage("p-site-3", "doc-site", 2, "At the airport", "Bag drop closes 45 minutes before departure.", `${SITE}/help/check-in`),
  passage("p-note-1", "doc-note", 0, null, "Billing questions belong to the workspace owner.", null),
  // Its source row is gone. It has nothing to hang from and is not drawn.
  passage("p-orphan", "doc-deleted", 0, "Orphan", "No source.", null),
];

function control(id: string, route: string, role: string, name: string, href?: string) {
  return {
    id,
    route,
    key: `${role}|${name.toLowerCase()}|nav|${href ?? ""}`,
    role,
    name,
    landmark: "navigation",
    visible: true,
    seenCount: 1,
    lastSeen: SEEN,
    ...(href ? { href } : {}),
  };
}

const homeHelp = control("c-home-help", "/", "link", "Help", "/help/check-in");
const homeTrips = control("c-home-trips", "/", "link", "My trips", "/trips/:id");
const homeMenu = control("c-home-menu", "/", "button", "Menu");
const homeSignOut = control("c-home-out", "/", "button", "Sign out");
const helpHome = control("c-help-home", "/help/check-in", "link", "NovaAir", "/");
const helpLogo = control("c-help-logo", "/help/check-in", "link", "Home", "/");

export const graph: StoredGraph = {
  pages: [
    { route: "/", url: `${SITE}/`, title: "NovaAir", source: "widget", firstSeen: SEEN, lastSeen: SEEN },
    { route: "/help/check-in", url: `${SITE}/help/check-in`, title: "Check-in | NovaAir", source: "widget", firstSeen: SEEN, lastSeen: SEEN },
    { route: "/trips/:id", url: `${SITE}/trips/NVA7K2`, title: "Manage Trip | NovaAir", source: "widget", firstSeen: SEEN, lastSeen: SEEN },
  ],
  controls: [homeHelp, homeTrips, homeMenu, homeSignOut, helpHome, helpLogo],
  transitions: [
    { from: "/", key: homeHelp.key, to: "/help/check-in", kind: "navigation", source: "widget", seenCount: 2, lastSeen: SEEN },
    { from: "/", key: homeTrips.key, to: "/trips/:id", kind: "navigation", source: "widget", seenCount: 1, lastSeen: SEEN },
    { from: "/help/check-in", key: helpHome.key, to: "/", kind: "navigation", source: "widget", seenCount: 1, lastSeen: SEEN },
    { from: "/help/check-in", key: helpLogo.key, to: "/", kind: "navigation", source: "widget", seenCount: 1, lastSeen: SEEN },
    { from: "/", key: homeMenu.key, to: "/", kind: "reveal", reveals: homeSignOut.key, source: "explorer", seenCount: 1, lastSeen: SEEN },
  ],
};

export const map = shapeKnowledgeMap({ documents, passages, graph });
export const index: MapIndex = indexMap(map);
