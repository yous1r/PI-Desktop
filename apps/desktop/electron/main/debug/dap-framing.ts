/**
 * Debug Adapter Protocol (DAP) wire framing codec.
 *
 * Each message consists of two parts: a header and content.
 * Header lines are terminated by \r\n, and the header part is separated from the
 * content part by an extra \r\n (i.e. \r\n\r\n).
 * Mandatory header field:
 *   Content-Length: <length in bytes>
 * Optional header field:
 *   Content-Type: <media type> (default: application/json; charset=utf-8)
 *
 * The parser is incremental, surviving partial reads and multiple messages per chunk,
 * and caps the declared length (rejecting > 8 MiB) before allocating memory.
 */

export const MAX_DAP_MESSAGE_BYTES = 8 * 1024 * 1024; // 8 MiB ceiling
export const MAX_DAP_HEADER_BYTES = 64 * 1024; // 64 KiB defense against unbounded header buffers

export type DapMessageType = "request" | "response" | "event";

export type DapProtocolMessage = {
  seq: number;
  type: DapMessageType;
};

export type DapRequest = DapProtocolMessage & {
  type: "request";
  command: string;
  arguments?: Record<string, unknown>;
};

export type DapResponse = DapProtocolMessage & {
  type: "response";
  request_seq: number;
  success: boolean;
  command: string;
  message?: string;
  body?: Record<string, unknown>;
};

export type DapEvent = DapProtocolMessage & {
  type: "event";
  event: string;
  body?: Record<string, unknown>;
};

export type DapMessage = DapRequest | DapResponse | DapEvent;

/**
 * Encodes a DAP message into the wire format:
 * Content-Length: <byteLength>\r\n\r\n<JSON-payload>
 */
export function encodeDapMessage(message: unknown): Buffer {
  const json = JSON.stringify(message);
  const payload = Buffer.from(json, "utf8");
  const header = Buffer.from(`Content-Length: ${payload.byteLength}\r\n\r\n`, "utf8");
  return Buffer.concat([header, payload]);
}

/**
 * Incremental parser for DAP wire format messages over a TCP stream.
 */
export class DapDecoder {
  private buffer: Buffer = Buffer.alloc(0);

  /**
   * Feed a new chunk of data from the socket.
   * Returns any complete parsed messages.
   * Throws if the message length exceeds the limit or the message is malformed.
   */
  push(chunk: Uint8Array | Buffer): DapMessage[] {
    if (!chunk || chunk.byteLength === 0) {
      return [];
    }

    const chunkBuf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.buffer =
      this.buffer.byteLength === 0
        ? chunkBuf
        : Buffer.concat([this.buffer, chunkBuf]);

    const messages: DapMessage[] = [];

    while (this.buffer.byteLength > 0) {
      const headerEndIndex = this.findHeaderEnd(this.buffer);

      if (headerEndIndex === -1) {
        if (this.buffer.byteLength > MAX_DAP_HEADER_BYTES) {
          this.reset();
          throw new Error(
            `DAP header exceeded limit of ${MAX_DAP_HEADER_BYTES} bytes without separator`
          );
        }
        // Need more data to finish headers
        break;
      }

      // Parse headers from [0, headerEndIndex)
      const headerBytes = this.buffer.subarray(0, headerEndIndex);
      const headerText = headerBytes.toString("utf8");
      const contentLength = this.parseContentLength(headerText);

      // Enforce the size ceiling BEFORE allocating or buffering the payload
      if (contentLength > MAX_DAP_MESSAGE_BYTES) {
        this.reset();
        throw new Error(
          `DAP message declared length ${contentLength} exceeds ${MAX_DAP_MESSAGE_BYTES} byte limit`
        );
      }

      const bodyStartIndex = headerEndIndex + 4; // Skip \r\n\r\n
      const messageEndIndex = bodyStartIndex + contentLength;

      if (this.buffer.byteLength < messageEndIndex) {
        // Full payload has not arrived yet; wait for more chunks
        break;
      }

      // Extract the message body
      const bodyBytes = this.buffer.subarray(bodyStartIndex, messageEndIndex);
      this.buffer = this.buffer.subarray(messageEndIndex);
      if (this.buffer.byteLength === 0) {
        this.buffer = Buffer.alloc(0);
      }

      const jsonText = bodyBytes.toString("utf8");
      try {
        const parsed = JSON.parse(jsonText) as DapMessage;
        messages.push(parsed);
      } catch (parseErr) {
        this.reset();
        throw new Error(
          `DAP message body is not valid JSON: ${
            parseErr instanceof Error ? parseErr.message : String(parseErr)
          }`
        );
      }
    }

    return messages;
  }

  /**
   * Resets the internal buffer state.
   */
  reset(): void {
    this.buffer = Buffer.alloc(0);
  }

  /**
   * Current unparsed buffer length (for diagnostics and testing).
   */
  get bufferedBytes(): number {
    return this.buffer.byteLength;
  }

  private findHeaderEnd(buf: Buffer): number {
    // Search for \r\n\r\n (0x0D, 0x0A, 0x0D, 0x0A)
    const len = buf.byteLength;
    for (let i = 0; i <= len - 4; i++) {
      if (
        buf[i] === 0x0d &&
        buf[i + 1] === 0x0a &&
        buf[i + 2] === 0x0d &&
        buf[i + 3] === 0x0a
      ) {
        return i;
      }
    }
    return -1;
  }

  private parseContentLength(headerText: string): number {
    const lines = headerText.split("\r\n");
    let contentLength: number | null = null;

    for (const rawLine of lines) {
      const line = rawLine.trim();
      const match = /^Content-Length:\s*(\d+)\s*$/i.exec(line);
      if (match) {
        contentLength = Number.parseInt(match[1], 10);
        break;
      }
    }

    if (contentLength === null || !Number.isFinite(contentLength) || contentLength < 0) {
      throw new Error("Missing or invalid Content-Length header in DAP message");
    }

    return contentLength;
  }
}
