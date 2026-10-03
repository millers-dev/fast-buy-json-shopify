import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { buildDetectResponse } from "./detect.js";
import type { ConnectorConfig } from "./config.js";

export const DEFAULT_PORT = 3100;
export const BASE_PATH = "/api/fastbuyjson";
export const DETECT_PATH = `${BASE_PATH}/detect`;
export const DETECT_CACHE_CONTROL = "public, max-age=300";

export function createConnectorServer(config: ConnectorConfig): Server {
  const detectBody = JSON.stringify(buildDetectResponse(config));
  return createServer((req, res) => {
    handle(req, res, detectBody);
  });
}

export function listen(server: Server, port: number, host?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      reject(error);
    };
    server.once("error", onError);
    const onListening = () => {
      server.off("error", onError);
      const address = server.address();
      if (address && typeof address === "object") {
        resolve(address.port);
        return;
      }
      reject(new Error("connector is not listening on a TCP port"));
    };
    if (host === undefined) {
      server.listen(port, onListening);
      return;
    }
    server.listen(port, host, onListening);
  });
}

function handle(req: IncomingMessage, res: ServerResponse, detectBody: string): void {
  const pathname = requestPathname(req);
  if (pathname !== DETECT_PATH) {
    writeJson(res, 404, { error: "not_found" }, { "Cache-Control": "no-store" });
    return;
  }
  if (req.method !== "GET") {
    writeJson(
      res,
      405,
      { error: "method_not_allowed" },
      { Allow: "GET", "Cache-Control": "no-store" },
    );
    return;
  }

  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": DETECT_CACHE_CONTROL,
  });
  res.end(detectBody);
}

function requestPathname(req: IncomingMessage): string {
  const raw = req.url ?? "/";
  return new URL(raw, "http://127.0.0.1").pathname;
}

function writeJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string>,
): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    ...headers,
  });
  res.end(JSON.stringify(body));
}
