const EMOJI_OR_VARIATION = /[\p{Extended_Pictographic}\u200D\uFE0F]/gu;
const INLINE_LABEL =
  /[ \t]+(?=(?:Severity|Type|Vehicle|Device ID|Description|Details|Location|Time|Recommended action|Action):)/gi;

/**
 * Converts model output to readable plain text. The AI endpoint can return
 * Markdown or emoji even when asked not to, so presentation never relies on
 * the model following formatting instructions perfectly.
 */
export function formatAiPlainText(value: unknown, fallback = ''): string {
  if (typeof value !== 'string') return fallback;

  const formatted = value
    .normalize('NFKC')
    .replace(/\r\n?/g, '\n')
    .replace(/```(?:[^\n]*)\n?([\s\S]*?)```/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/~~(.*?)~~/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')
    .replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, '')
    .replace(/\bEvent\s+#(?=\d)/gi, 'Event ')
    .replace(/#(?=\d)/g, '')
    .replace(/\*/g, '')
    .replace(EMOJI_OR_VARIATION, '')
    .replace(/[–—]/g, '-')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/…/g, '...')
    .replace(INLINE_LABEL, '\n')
    .replace(/^(Event\s+\d+)\s*:\s*/i, '$1\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return formatted || fallback;
}
