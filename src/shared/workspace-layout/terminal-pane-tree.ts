import type { TerminalPaneLayoutNode } from '../terminal-tab-types'

export function collectLayoutLeafIdsInOrder(
  node: TerminalPaneLayoutNode | null | undefined
): string[] {
  if (!node) {
    return []
  }
  if (node.type === 'leaf') {
    return [node.leafId]
  }
  return [...collectLayoutLeafIdsInOrder(node.first), ...collectLayoutLeafIdsInOrder(node.second)]
}

export function firstLayoutLeafId(node: TerminalPaneLayoutNode | null): string | null {
  if (!node) {
    return null
  }
  return node.type === 'leaf' ? node.leafId : firstLayoutLeafId(node.first)
}

export function layoutContainsLeafId(node: TerminalPaneLayoutNode | null, leafId: string): boolean {
  if (!node) {
    return false
  }
  if (node.type === 'leaf') {
    return node.leafId === leafId
  }
  return layoutContainsLeafId(node.first, leafId) || layoutContainsLeafId(node.second, leafId)
}

/** The tree without `leafId`; its parent split collapses into the sibling. */
export function removeLayoutLeaf(
  node: TerminalPaneLayoutNode | null,
  leafId: string
): TerminalPaneLayoutNode | null {
  if (!node) {
    return null
  }
  if (node.type === 'leaf') {
    return node.leafId === leafId ? null : node
  }
  const first = removeLayoutLeaf(node.first, leafId)
  const second = removeLayoutLeaf(node.second, leafId)
  if (!first || !second) {
    return first ?? second
  }
  return first === node.first && second === node.second ? node : { ...node, first, second }
}
