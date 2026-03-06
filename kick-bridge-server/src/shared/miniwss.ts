import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export type MiniWsConnectionHandlers = {
  onMessage?: (message: string) => void;
  onClose?: () => void;
  onError?: (error: Error) => void;
};

export class MiniWsConnection {
  private readonly socket: Socket;
  private readonly handlers: MiniWsConnectionHandlers;
  private buffer = Buffer.alloc(0);
  private closed = false;

  constructor(socket: Socket, handlers: MiniWsConnectionHandlers) {
    this.socket = socket;
    this.handlers = handlers;
    socket.on("data", (chunk) => this.ingest(chunk));
    socket.on("close", () => {
      this.closed = true;
      handlers.onClose?.();
    });
    socket.on("error", (error) => {
      handlers.onError?.(error);
    });
  }

  sendText(payload: string): void {
    if (this.closed) {
      return;
    }
    const data = Buffer.from(payload, "utf8");
    const frame = encodeServerFrame(0x1, data);
    this.socket.write(frame);
  }

  sendJson(payload: unknown): void {
    this.sendText(JSON.stringify(payload));
  }

  close(code = 1000, reason = "normal"): void {
    if (this.closed) {
      return;
    }
    const reasonBuffer = Buffer.from(reason, "utf8");
    const codeBuffer = Buffer.alloc(2);
    codeBuffer.writeUInt16BE(code, 0);
    const body = Buffer.concat([codeBuffer, reasonBuffer]);
    this.socket.write(encodeServerFrame(0x8, body));
    this.socket.end();
    this.closed = true;
  }

  ingest(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const parsed = decodeFrame(this.buffer);
      if (!parsed) {
        break;
      }
      this.buffer = this.buffer.subarray(parsed.frameLength);
      const { opcode, payload } = parsed;
      if (opcode === 0x8) {
        this.close();
        return;
      }
      if (opcode === 0x9) {
        this.socket.write(encodeServerFrame(0xA, payload));
        continue;
      }
      if (opcode === 0x1) {
        this.handlers.onMessage?.(payload.toString("utf8"));
      }
    }
  }
}

export function tryUpgradeToWebSocket(
  req: IncomingMessage,
  socket: Socket,
  head: Buffer,
  handlers: MiniWsConnectionHandlers,
): MiniWsConnection | null {
  const upgrade = req.headers.upgrade;
  const connection = req.headers.connection;
  const key = req.headers["sec-websocket-key"];
  const version = req.headers["sec-websocket-version"];

  const upgradeOk = typeof upgrade === "string" && upgrade.toLowerCase() === "websocket";
  const connectionOk = typeof connection === "string" && connection.toLowerCase().includes("upgrade");
  const keyOk = typeof key === "string" && key.length > 0;
  const versionOk = version === "13";

  if (!upgradeOk || !connectionOk || !keyOk || !versionOk) {
    socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return null;
  }

  const accept = createHash("sha1").update(`${key}${WS_GUID}`).digest("base64");
  const headers = [
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`,
    "\r\n",
  ];
  socket.write(headers.join("\r\n"));
  const conn = new MiniWsConnection(socket, handlers);
  if (head.length > 0) {
    conn.ingest(head);
  }
  return conn;
}

type DecodedFrame = {
  opcode: number;
  payload: Buffer;
  frameLength: number;
};

function decodeFrame(buffer: Buffer): DecodedFrame | null {
  if (buffer.length < 2) {
    return null;
  }

  const first = buffer[0];
  const second = buffer[1];
  const opcode = first & 0x0f;
  const masked = (second & 0x80) !== 0;
  let payloadLength = second & 0x7f;
  let offset = 2;

  if (payloadLength === 126) {
    if (buffer.length < offset + 2) {
      return null;
    }
    payloadLength = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (payloadLength === 127) {
    if (buffer.length < offset + 8) {
      return null;
    }
    const high = buffer.readUInt32BE(offset);
    const low = buffer.readUInt32BE(offset + 4);
    if (high !== 0) {
      throw new Error("Frame too large for this bridge implementation");
    }
    payloadLength = low;
    offset += 8;
  }

  let maskingKey: Buffer | undefined;
  if (masked) {
    if (buffer.length < offset + 4) {
      return null;
    }
    maskingKey = buffer.subarray(offset, offset + 4);
    offset += 4;
  }

  if (buffer.length < offset + payloadLength) {
    return null;
  }

  const payload = Buffer.from(buffer.subarray(offset, offset + payloadLength));
  if (masked && maskingKey) {
    for (let i = 0; i < payload.length; i += 1) {
      payload[i] ^= maskingKey[i % 4];
    }
  }

  return {
    opcode,
    payload,
    frameLength: offset + payloadLength,
  };
}

function encodeServerFrame(opcode: number, payload: Buffer): Buffer {
  const payloadLength = payload.length;
  let header: Buffer;
  if (payloadLength < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = payloadLength;
  } else if (payloadLength < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 126;
    header.writeUInt16BE(payloadLength, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(payloadLength, 6);
  }
  return Buffer.concat([header, payload]);
}
