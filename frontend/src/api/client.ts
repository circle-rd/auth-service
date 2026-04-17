const USE_MOCK = import.meta.env.VITE_USE_MOCK === 'true';

export { USE_MOCK };

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const url = `/api${path}`;
  // Only set Content-Type: application/json when there is actually a body to send.
  // Sending the header on body-less requests (DELETE, GET) causes Fastify to attempt
  // JSON parsing of an empty body and return 400 FST_ERR_CTP_EMPTY_JSON_BODY.
  const hasBody = options?.body != null;
  const response = await fetch(url, {
    ...options,
    credentials: 'include',
    headers: {
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      ...options?.headers,
    },
  });

  if (!response.ok) {
    let body: { error?: { code?: string; message?: string; details?: unknown } } = {};
    try {
      body = await response.json() as typeof body;
    } catch {
      // ignore
    }
    const err = body.error;
    throw new ApiError(
      err?.code ?? `HTTP_${response.status}`,
      err?.message ?? `Request failed with status ${response.status}`,
      err?.details,
    );
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}
