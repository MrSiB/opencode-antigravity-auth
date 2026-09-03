declare module "@openauthjs/openauth/pkce" {
  interface PkcePair {
    challenge: string;
    verifier: string;
  }

  export function generatePKCE(): Promise<PkcePair>;
}

interface Transformer<I = any, O = any> {
  cancel?(reason?: unknown): void | PromiseLike<void>;
}
