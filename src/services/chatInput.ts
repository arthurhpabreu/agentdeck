/** Match the native UTF-8 transport limit. Token estimates are advisory only. */
export const MAX_CHAT_INPUT_BYTES = 2 * 1024 * 1024;
export function chatInputError(prompt: string): string | undefined {
  const bytes = new TextEncoder().encode(prompt).length;
  return bytes > MAX_CHAT_INPUT_BYTES ? `This input contains ${bytes.toLocaleString()} UTF-8 bytes; the limit is ${MAX_CHAT_INPUT_BYTES.toLocaleString()} bytes (2 MiB). Your draft is preserved. Attach reference text as a file or split the request.` : undefined;
}
