// ============================================================
// Element Discoverer
// Converts raw SerializedNodes into DiscoveredElements,
// filtering for interactive elements by default.
// ============================================================

import { SerializedNode, DiscoveredElement } from '../types';
import { v4Fallback } from './uid';

/**
 * Converts serialized DOM nodes into DiscoveredElement objects.
 * By default, only interactive elements are returned.
 */
export class ElementDiscoverer {
  /**
   * Discover actionable elements from raw serialized nodes.
   *
   * @param nodes - Raw nodes from the traverser
   * @param includeNonInteractive - If true, include all elements
   * @param maxElements - Maximum number of elements to return
   */
  discover(
    nodes: SerializedNode[],
    includeNonInteractive = false,
    maxElements = 200,
  ): DiscoveredElement[] {
    let filtered = nodes;

    if (!includeNonInteractive) {
      filtered = nodes.filter((n) => n.isInteractive);
    }

    // Limit output size
    filtered = filtered.slice(0, maxElements);

    return filtered.map((node, index) => this.toDiscoveredElement(node, index));
  }

  private toDiscoveredElement(node: SerializedNode, index: number): DiscoveredElement {
    return {
      uid: v4Fallback(index),
      tag: node.tag,
      text: node.text,
      attributes: node.attributes,
      shadowDepth: node.shadowDepth,
      shadowHostChain: node.shadowHostChain,
      shadowHost: node.shadowHost,
      ariaRole: node.ariaRole,
      cssPathSegments: node.cssPathSegments,
      isInteractive: node.isInteractive,
      boundingBox: node.boundingBox,
      htmlSnippet: node.htmlSnippet,
      childCount: node.childCount,
      nthOfType: node.nthOfType,
      siblingsOfSameType: node.siblingsOfSameType,
      nodeIndex: node.nodeIndex,
    };
  }
}
