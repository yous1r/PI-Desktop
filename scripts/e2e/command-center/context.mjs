/** Exact UTF-8 payload bytes, excluding the session-routing prefix. */
export function contextText(bytes, kind = 'ascii') {
  const unit = kind === 'utf8' ? 'Context \u4e2d\u6587 \ud83d\ude80\n' : 'Fixture context preserves API behavior and documents evidence.\n';
  const size = Buffer.byteLength(unit);
  return unit.repeat(Math.floor(bytes / size)) + 'x'.repeat(bytes % size);
}

export function promptText(key, bytes, kind = 'ascii') {
  return `P0_SESSION:${key}\n${contextText(bytes, kind)}`;
}
