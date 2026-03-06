import net, { type Socket } from "node:net";
import { logger } from "../shared/logger.ts";

export type Socks5Destination = {
  host: string;
  port: number;
};

export type Socks5RedirectConfig = {
  bindHost: string;
  bindPort: number;
  redirectHost: string;
  redirectPort: number;
  allowedDestPort: number;
  allowedDestHosts: string[];
  allowedDestIps: string[];
};

type ParsedSocks5Request = {
  destination: Socks5Destination;
  frameLength: number;
};

export class Socks5RedirectServer {
  private readonly config: Socks5RedirectConfig;
  private readonly server: net.Server;

  constructor(config: Socks5RedirectConfig) {
    this.config = config;
    this.server = net.createServer((socket) => this.handleClient(socket));
  }

  start(): void {
    this.server.listen(this.config.bindPort, this.config.bindHost, () => {
      logger.info("Local SOCKS5 redirect server listening", {
        host: this.config.bindHost,
        port: this.config.bindPort,
        redirectHost: this.config.redirectHost,
        redirectPort: this.config.redirectPort,
      });
    });
    this.server.on("error", (error) => {
      logger.error("Local SOCKS5 server error", { error: error.message });
    });
  }

  stop(): void {
    this.server.close();
  }

  private handleClient(client: Socket): void {
    let stage: "greeting" | "request" | "connecting" | "proxying" | "closed" = "greeting";
    let buffer = Buffer.alloc(0);
    let upstream: Socket | null = null;

    const closeAll = () => {
      stage = "closed";
      if (upstream && !upstream.destroyed) {
        upstream.destroy();
      }
      if (!client.destroyed) {
        client.destroy();
      }
    };

    client.on("error", () => {
      closeAll();
    });

    client.on("close", () => {
      if (upstream && !upstream.destroyed) {
        upstream.destroy();
      }
    });

    client.on("data", (chunk) => {
      if (stage === "closed") {
        return;
      }
      if (stage === "proxying") {
        return;
      }

      buffer = Buffer.concat([buffer, chunk]);

      while (true) {
        if (stage === "greeting") {
          if (buffer.length < 2) {
            return;
          }
          const version = buffer[0];
          const methodsCount = buffer[1];
          const totalLength = 2 + methodsCount;
          if (buffer.length < totalLength) {
            return;
          }
          const methods = buffer.subarray(2, totalLength);
          buffer = buffer.subarray(totalLength);

          if (version !== 0x05 || !methods.includes(0x00)) {
            client.write(Buffer.from([0x05, 0xff]));
            closeAll();
            return;
          }
          client.write(Buffer.from([0x05, 0x00]));
          stage = "request";
          continue;
        }

        if (stage === "request") {
          const parsed = parseSocks5ConnectRequest(buffer);
          if (!parsed) {
            return;
          }
          const { destination, frameLength } = parsed;
          buffer = buffer.subarray(frameLength);

          if (!isSocksDestinationAllowed(destination, this.config)) {
            client.write(failureReply(0x02));
            closeAll();
            return;
          }

          stage = "connecting";
          upstream = net.createConnection(
            {
              host: this.config.redirectHost,
              port: this.config.redirectPort,
            },
            () => {
              if (stage === "closed") {
                return;
              }
              client.write(successReply());
              if (buffer.length > 0) {
                upstream?.write(buffer);
                buffer = Buffer.alloc(0);
              }
              stage = "proxying";
              client.pipe(upstream as Socket);
              (upstream as Socket).pipe(client);
            },
          );

          upstream.on("error", () => {
            if (stage === "connecting") {
              client.write(failureReply(0x05));
            }
            closeAll();
          });
          upstream.on("close", () => {
            if (!client.destroyed) {
              client.destroy();
            }
          });
          return;
        }

        return;
      }
    });
  }
}

export function parseSocks5ConnectRequest(buffer: Buffer): ParsedSocks5Request | null {
  if (buffer.length < 4) {
    return null;
  }
  const version = buffer[0];
  const cmd = buffer[1];
  const atyp = buffer[3];
  if (version !== 0x05 || cmd !== 0x01) {
    return null;
  }

  let offset = 4;
  let host = "";

  if (atyp === 0x01) {
    if (buffer.length < offset + 4 + 2) {
      return null;
    }
    host = `${buffer[offset]}.${buffer[offset + 1]}.${buffer[offset + 2]}.${buffer[offset + 3]}`;
    offset += 4;
  } else if (atyp === 0x03) {
    if (buffer.length < offset + 1) {
      return null;
    }
    const hostLength = buffer[offset];
    offset += 1;
    if (buffer.length < offset + hostLength + 2) {
      return null;
    }
    host = buffer.subarray(offset, offset + hostLength).toString("utf8");
    offset += hostLength;
  } else if (atyp === 0x04) {
    if (buffer.length < offset + 16 + 2) {
      return null;
    }
    const parts: string[] = [];
    for (let i = 0; i < 16; i += 2) {
      parts.push(buffer.readUInt16BE(offset + i).toString(16));
    }
    host = parts.join(":");
    offset += 16;
  } else {
    return null;
  }

  const port = buffer.readUInt16BE(offset);
  offset += 2;

  return {
    destination: {
      host: host.toLowerCase(),
      port,
    },
    frameLength: offset,
  };
}

export function isSocksDestinationAllowed(
  destination: Socks5Destination,
  config: Pick<Socks5RedirectConfig, "allowedDestPort" | "allowedDestHosts" | "allowedDestIps">,
): boolean {
  if (destination.port !== config.allowedDestPort) {
    return false;
  }
  const host = destination.host.toLowerCase();
  if (config.allowedDestHosts.length === 0 && config.allowedDestIps.length === 0) {
    return true;
  }
  if (config.allowedDestHosts.includes(host)) {
    return true;
  }
  if (config.allowedDestIps.includes(host)) {
    return true;
  }
  return false;
}

function successReply(): Buffer {
  return Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);
}

function failureReply(code: number): Buffer {
  return Buffer.from([0x05, code & 0xff, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);
}
