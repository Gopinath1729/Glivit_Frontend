import type { ChatMessageDto } from './aiApi';

/**
 * The greeting the chat screen seeds the thread with. It is UI text, not a
 * conversation turn, so it must never be sent back to the backend — encoding it
 * into every prompt costs latency and buys nothing.
 */
export const CHAT_GREETING =
  "Hello! I'm your Glivt AI Fleet Assistant. Ask me about fleet status, maintenance, alerts, driver scores, routes, fuel, or reports.";

/** Turns kept per request. More history means a bigger, slower prompt. */
const MAX_HISTORY_MESSAGES = 6;
/** Per-message cap, so one long answer cannot dominate the prompt. */
const MAX_HISTORY_CHARS = 400;

const CANNED_PREFIXES = [
  "hello! i'm your glivt ai fleet assistant",
  'the assistant could not be reached',
];

function isCanned(content: string): boolean {
  const lower = content.trim().toLowerCase();
  return CANNED_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/**
 * The last few meaningful turns, trimmed and capped, ready to send with the
 * next question. Static greetings and local error placeholders are dropped.
 */
export function buildChatHistory(messages: ChatMessageDto[]): ChatMessageDto[] {
  return messages
    .filter((message) => {
      const content = message?.content?.trim();
      return Boolean(content) && !isCanned(content as string);
    })
    .slice(-MAX_HISTORY_MESSAGES)
    .map(({ role, content, timestamp }) => ({
      role,
      content: content.trim().slice(0, MAX_HISTORY_CHARS),
      timestamp,
    }));
}
