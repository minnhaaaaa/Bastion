import { env } from "../env";
export async function api<T>(
  path: string,
  token = "",
  body?: unknown,
): Promise<T> {
  const response = await fetch(`${env.apiUrl}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(
      data.error?.message || `Request failed (${response.status})`,
    );
  return data as T;
}
