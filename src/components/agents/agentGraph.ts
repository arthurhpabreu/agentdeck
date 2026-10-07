import type { AgentNode } from "./AgentObservatory";

export const agentWorking = (status: string) => ["starting", "connected", "running"].includes(status);
export const taskColumn = (status: string) => agentWorking(status) ? "running" : ["waiting", "error"].includes(status) ? "attention" : status === "done" ? "completed" : "waiting";

/** Malformed provider hierarchies must not leave agents unreachable. */
export function normalizeAgentParents(nodes: AgentNode[]): AgentNode[] {
  const byKey = new Map(nodes.map(node => [node.key, node]));
  return nodes.map(node => {
    if (node.isRoot) return node;
    const root = `${node.session.id}:main`;
    let key = node.parentKey; const visited = new Set([node.key]);
    while (key && key !== root) {
      if (visited.has(key) || !byKey.has(key)) return { ...node, parentKey: root };
      visited.add(key); key = byKey.get(key)?.parentKey;
    }
    return { ...node, parentKey: key === root ? node.parentKey : root };
  });
}

export function layoutAgents(nodes: AgentNode[]) {
  const positions = new Map<string, { x: number; y: number }>();
  const lanes: { key: string; title: string; y: number; height: number }[] = [];
  let offset = 60, maxDepth = 0;
  const children = new Map<string, AgentNode[]>();
  for (const node of nodes) {
    if (!node.parentKey) continue;
    if (!children.has(node.parentKey)) children.set(node.parentKey, []);
    children.get(node.parentKey)!.push(node);
  }
  for (const root of nodes.filter(node => node.isRoot)) {
    let row = 0;
    const place = (node: AgentNode, depth: number): number => {
      maxDepth = Math.max(maxDepth, depth);
      const ys = (children.get(node.key) ?? []).map(child => place(child, depth + 1));
      const y = ys.length ? (ys[0] + ys[ys.length - 1]) / 2 : offset + row++ * 230;
      positions.set(node.key, { x: 32 + depth * 330, y }); return y;
    };
    place(root, 0);
    const height = Math.max(1, row) * 230;
    lanes.push({ key: root.key, title: root.name, y: offset - 32, height });
    offset += height + 64;
  }
  return { positions, lanes, width: (maxDepth + 1) * 330, height: Math.max(270, offset - 30) };
}
