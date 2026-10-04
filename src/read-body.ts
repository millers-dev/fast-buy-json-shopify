import type { IncomingMessage } from "node:http";

const DEFAULT_LIMIT = 1_000_000;

export class RequestBodyTooLargeError extends Error {
  constructor() {
    super("request body is too large");
    this.name = "RequestBodyTooLargeError";
  }
}

export function readRequestBody(req: IncomingMessage, limit = DEFAULT_LIMIT): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      fn();
    };
    const onData = (chunk: Buffer) => {
      total += chunk.length;
      if (total > limit) {
        req.destroy();
        finish(() => {
          reject(new RequestBodyTooLargeError());
        });
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      finish(() => {
        resolve(Buffer.concat(chunks));
      });
    };
    const onError = (error: Error) => {
      finish(() => {
        reject(error);
      });
    };
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });
}
