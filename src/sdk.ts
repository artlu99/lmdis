// HTTP client mirroring the @upstash/redis SDK surface for lmdis.

export type LmdisClientConfig = {
  url: string;
  token: string;
  fetch?: typeof fetch;
};

export type SetCommandOptions = {
  ex?: number;
  px?: number;
  exat?: number;
  pxat?: number;
  keepTtl?: boolean;
  get?: boolean;
  nx?: boolean;
  xx?: boolean;
};

export class LmdisError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LmdisError";
  }
}

const serialize = (value: unknown): string => {
  switch (typeof value) {
    case "string":
      return value;
    case "number":
    case "boolean":
      return String(value);
    default:
      return JSON.stringify(value);
  }
};

const deserialize = <T>(value: string | null): T | null => {
  if (value === null) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return value as T;
  }
};

const unsupportedSetOptions = (opts?: SetCommandOptions): string | null => {
  if (!opts) return null;
  if (opts.ex !== undefined) return "ex";
  if (opts.px !== undefined) return "px";
  if (opts.exat !== undefined) return "exat";
  if (opts.pxat !== undefined) return "pxat";
  if (opts.keepTtl) return "keepTtl";
  if (opts.get) return "get";
  if (opts.nx) return "nx";
  if (opts.xx) return "xx";
  return null;
};

export class LmdisClient {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly fetchFn: typeof fetch;

  constructor(config: LmdisClientConfig) {
    this.baseUrl = config.url.replace(/\/$/, "");
    this.headers = {
      Authorization: `Bearer ${config.token}`,
      "Content-Type": "application/json",
    };
    this.fetchFn = config.fetch ?? fetch;
  }

  private async request<T>(body: unknown[]): Promise<T> {
    const res = await this.fetchFn(this.baseUrl, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as { result?: T; error?: string; code?: string };
    if (!res.ok) {
      throw new LmdisError(data.error ?? `request failed with status ${res.status}`);
    }
    if (data.result === undefined) {
      throw new LmdisError("request did not return a result");
    }
    return data.result;
  }

  async set<T>(key: string, value: T, opts?: SetCommandOptions): Promise<"OK" | null> {
    const unsupported = unsupportedSetOptions(opts);
    if (unsupported) {
      throw new LmdisError(`SET option "${unsupported}" is not supported by lmdis`);
    }
    await this.request<"OK">(["SET", key, serialize(value)]);
    return "OK";
  }

  async get<T>(key: string): Promise<T | null> {
    const result = await this.request<string | null>(["GET", key]);
    return deserialize<T>(result);
  }

  async del(...keys: string[]): Promise<number> {
    let removed = 0;
    for (const key of keys) {
      removed += await this.request<number>(["DEL", key]);
    }
    return removed;
  }

  async hincrby(key: string, field: string, increment: number): Promise<number> {
    return this.request<number>(["HINCR", key, field, String(increment)]);
  }

  async sadd(key: string, ...members: (string | number)[]): Promise<number> {
    let added = 0;
    for (const member of members) {
      added += await this.request<number>(["SADD", key, serialize(member)]);
    }
    return added;
  }

  async smembers(key: string): Promise<string[]> {
    return this.request<string[]>(["SMEMB", key]);
  }

  async srem(key: string, ...members: (string | number)[]): Promise<number> {
    let removed = 0;
    for (const member of members) {
      removed += await this.request<number>(["SDEL", key, serialize(member)]);
    }
    return removed;
  }
}
