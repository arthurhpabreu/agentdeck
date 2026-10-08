// Keep argument lists bounded when pasting large UTF-8 text into the terminal.
export function encodeTerminalInput(data: string): string {
  const bytes = new TextEncoder().encode(data);
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 8192)));
  }
  return btoa(chunks.join(""));
}
