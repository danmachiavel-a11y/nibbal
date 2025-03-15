declare module 'node-fetch' {
  import type { RequestInit, Response } from 'node-fetch';
  export * from 'node-fetch';
  export default function fetch(url: string | URL, init?: RequestInit): Promise<Response>;
}