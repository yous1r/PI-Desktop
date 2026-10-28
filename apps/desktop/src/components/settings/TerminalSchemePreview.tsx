/**
 * Live preview for the terminal color scheme picker.
 *
 * The pane is drawn with the scheme's real palette (background, foreground and
 * the eight ANSI hues a shell actually paints with), so the choice is visible
 * before it is saved. It deliberately does not mount xterm: the preview must
 * render instantly on every hover/selection change and must not spawn a PTY.
 *
 * `app` is the only scheme without fixed colors, so it is rendered from the
 * live application theme tokens, which keeps the preview honest about what the
 * terminal will look like after the choice is saved.
 */
import { useEffect, useMemo, useState } from "react";

import type { TerminalColorSchemeId } from "@pi-desktop/shared";

import { terminalSchemeSwatches } from "../../lib/terminal-theme";

/** One line of shell-looking text, colored by the scheme's ANSI slots. */
type PreviewLine = { segments: { text: string; color: string }[] };

export function TerminalSchemePreview({
  schemeId,
  className,
}: {
  schemeId: TerminalColorSchemeId;
  className?: string;
}) {
  const [tokens, setTokens] = useState<CSSStyleDeclaration | null>(null);

  // The `app` scheme reads theme tokens from the document, so the preview has
  // to re-read them when the application theme changes. A MutationObserver on
  // `data-theme` covers the theme picker; the initial read covers first paint.
  useEffect(() => {
    const read = () => setTokens(getComputedStyle(document.documentElement));
    read();
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "class", "style"],
    });
    return () => observer.disconnect();
  }, []);

  const resolved = useMemo(() => {
    if (!tokens) return null;
    return terminalSchemeSwatches(schemeId, tokens);
  }, [schemeId, tokens]);

  const lines: PreviewLine[] = useMemo(() => {
    if (!resolved) return [];
    const [red, green, yellow, blue, magenta, cyan] = resolved.swatches;
    return [
      {
        segments: [
          { text: "user@host", color: green },
          { text: ":", color: resolved.swatches[0] },
          { text: "~/project", color: blue },
          { text: " $ ", color: resolved.swatches[0] },
          { text: "npm run build", color: resolved.swatches[0] },
        ],
      },
      {
        segments: [
          { text: "  ✓ compiled ", color: green },
          { text: "24 modules", color: resolved.swatches[0] },
        ],
      },
      {
        segments: [
          { text: "  warning ", color: yellow },
          { text: "unused import", color: resolved.swatches[0] },
          { text: " (line 12)", color: resolved.swatches[0] },
        ],
      },
      {
        segments: [
          { text: "  error ", color: red },
          { text: "type mismatch", color: resolved.swatches[0] },
          { text: " → ", color: magenta },
          { text: "expected string", color: cyan },
        ],
      },
    ];
  }, [resolved]);

  return (
    <div
      className={className ? `terminal-scheme-preview ${className}` : "terminal-scheme-preview"}
      style={
        resolved
          ? { background: resolved.background, color: resolved.swatches[0] }
          : undefined
      }
      aria-hidden="true"
    >
      {resolved ? (
        <>
          <div className="terminal-scheme-preview__lines">
            {lines.map((line, index) => (
              <div className="terminal-scheme-preview__line" key={index}>
                {line.segments.map((segment, segmentIndex) => (
                  <span key={segmentIndex} style={{ color: segment.color }}>
                    {segment.text}
                  </span>
                ))}
              </div>
            ))}
          </div>
          <div className="terminal-scheme-preview__swatches">
            {resolved.swatches.map((color, index) => (
              <span key={index} style={{ background: color }} />
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}
