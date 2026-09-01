declare module "cloudflare:workers" {
  export const env: Record<string, unknown> & { DB?: D1Database };
}

type Fetcher = { fetch(request: Request): Promise<Response> };
type D1Database = {
  prepare(query: string): unknown;
  batch(statements: unknown[]): Promise<unknown[]>;
  exec(query: string): Promise<unknown>;
  dump(): Promise<ArrayBuffer>;
};
