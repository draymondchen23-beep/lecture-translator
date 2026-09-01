declare module "ws" {
  import { EventEmitter } from "node:events";
  import type { IncomingMessage } from "node:http";
  import type { Socket } from "node:net";

  export type RawData = Buffer | ArrayBuffer | Buffer[];

  class WebSocket extends EventEmitter {
    static readonly OPEN: number;
    readonly readyState: number;
    constructor(address: string, options?: { headers?: Record<string, string> });
    send(data: string | Buffer): void;
    close(code?: number, data?: string): void;
    on(event: "open" | "close" | "error", listener: (...args: unknown[]) => void): this;
    on(event: "message", listener: (data: RawData, isBinary: boolean) => void): this;
  }

  class WebSocketServer extends EventEmitter {
    constructor(options: { noServer: true });
    handleUpgrade(request: IncomingMessage, socket: Socket, head: Buffer, callback: (client: WebSocket, request: IncomingMessage) => void): void;
    close(): void;
    on(event: "connection", listener: (client: WebSocket, request: IncomingMessage) => void): this;
  }

  export { WebSocket, WebSocketServer };
  export default WebSocket;
}
