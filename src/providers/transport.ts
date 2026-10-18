import { requestUrl } from "obsidian";

import type { HttpRequest, HttpResponse, HttpTransport } from "./http";

/** Obsidian requestUrl transport. Cancellation discards results; it cannot stop an in-flight request. */
export const obsidianTransport: HttpTransport = async (request: HttpRequest): Promise<HttpResponse> => {
  const response = await requestUrl({
    url: request.url,
    method: request.method,
    headers: request.headers,
    ...(request.body === undefined ? {} : { body: request.body }),
    throw: false,
  });

  return {
    status: response.status,
    headers: normalizeHeaders(response.headers),
    text: response.text,
  };
};

function normalizeHeaders(headers: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    result[key.toLowerCase()] = value;
  }
  return result;
}
