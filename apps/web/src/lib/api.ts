import { env } from "../env";
export class ApiRequestError extends Error {
  constructor(message: string, public readonly status: number) { super(message); }
}
export async function api<T>(
  path: string,
  token = "",
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`${env.apiUrl}${path}`, {
    method: body === undefined ? "GET" : "POST",
    signal,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok)
    throw new ApiRequestError(
      data.error?.message || `Request failed (${response.status})`,
      response.status,
    );
  return data as T;
}
