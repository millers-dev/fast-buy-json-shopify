import type { ServerResponse } from "node:http";

import { internalError, type Problem } from "./problems.js";

export function writeJson(
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

export function writeProblem(res: ServerResponse, problem: Problem): void {
  res.writeHead(problem.status, {
    "Content-Type": "application/problem+json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(problem));
}

export function writeUnexpected(res: ServerResponse): void {
  writeProblem(res, internalError("The request could not be completed."));
}
