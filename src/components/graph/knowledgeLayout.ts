import type { KnowledgeGraph, KnowledgeNode } from "../../services/knowledgeCommands";

export const noteFolder = (path: string) => path.replace(/\\/g, "/").split("/").slice(0, -1).join("/");

export function noteNeighborhood(graph: KnowledgeGraph, selected: string, depth: number) {
  const adjacency = new Map<string, Set<string>>();
  for (const edge of graph.edges) {
    if (!adjacency.has(edge.source)) adjacency.set(edge.source, new Set());
    if (!adjacency.has(edge.target)) adjacency.set(edge.target, new Set());
    adjacency.get(edge.source)!.add(edge.target); adjacency.get(edge.target)!.add(edge.source);
  }
  const included = new Set(selected ? [selected] : []);
  let frontier = [...included];
  for (let step = 0; step < depth; step++) {
    const next: string[] = [];
    for (const path of frontier) for (const neighbor of adjacency.get(path) ?? []) {
      if (!included.has(neighbor)) { included.add(neighbor); next.push(neighbor); }
    }
    frontier = next;
  }
  return included;
}

/** Folder clusters are stable, inexpensive and readable even in dense vaults. */
export function layoutNotes(nodes: KnowledgeNode[], overview = false) {
  const groups = new Map<string, KnowledgeNode[]>();
  for (const node of nodes) {
    const folder = noteFolder(node.path);
    if (!groups.has(folder)) groups.set(folder, []);
    groups.get(folder)!.push(node);
  }
  const sorted = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  const columns = Math.max(1, Math.ceil(Math.sqrt(sorted.length)));
  const cell = overview ? 260 : Math.max(260, ...sorted.map(([, list]) => Math.sqrt(list.length) * 46 + 120));
  const folders = sorted.map(([name, list], i) => ({ name, count: list.length, x: (i % columns + .5) * cell, y: (Math.floor(i / columns) + .5) * cell, radius: Math.max(62, Math.sqrt(list.length) * 22 + 32), color: i % 6 }));
  const positions = sorted.flatMap(([, list], group) => list.slice().sort((a, b) => a.path.localeCompare(b.path)).map((node, i) => {
    const radius = list.length === 1 ? 0 : 23 * Math.sqrt(i + .5);
    const angle = i * Math.PI * (3 - Math.sqrt(5));
    return { ...node, x: folders[group].x + Math.cos(angle) * radius, y: folders[group].y + Math.sin(angle) * radius, color: folders[group].color };
  }));
  return { nodes: positions, folders, width: columns * cell, height: Math.max(1, Math.ceil(sorted.length / columns)) * cell };
}
