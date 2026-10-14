// Project every static inventory from the turn's filtered execution pool.
// A deferred schema is usable only when the same pool includes ToolSearch.
import type { SystemSegment } from '../core/types.js';
import { safeStaticToolDescription } from './staticDescription.js';
import type { Tool } from './types.js';

export function effectiveToolInventory<T extends { name: string; shouldDefer?: boolean }>(
  tools: readonly T[],
): T[] {
  const canSearch = tools.some((tool) => tool.name === 'ToolSearch' && !tool.shouldDefer);
  return tools.filter((tool) => !tool.shouldDefer || canSearch);
}

/** Rewrite only the harness-owned segment. Preserve all standing instructions
 * and segment attributes. Never add an inventory to a host prompt without one. */
export function projectToolInventory(
  system: readonly SystemSegment[],
  tools: readonly { name: string; description?: unknown }[],
  descriptions = true,
): SystemSegment[] {
  return system.flatMap((segment) => {
    if (!segment.text.startsWith('<available-tools>\n')) return [segment];
    if (tools.length === 0) return [];
    const lines = tools.map((tool) => {
      const description = !descriptions
        ? ''
        : typeof tool.description === 'string'
          ? tool.description.replace(/\s+/g, ' ').trim()
          : typeof tool.description === 'function'
            ? safeStaticToolDescription(tool as Tool<unknown, unknown>)
                .replace(/\s+/g, ' ')
                .trim()
            : '';
      return `- ${tool.name}${description ? `: ${description}` : ''}`;
    });
    return [{ ...segment, text: ['<available-tools>', ...lines, '</available-tools>'].join('\n') }];
  });
}
