import "server-only";
export class AiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 502,
    public retryable = false,
    public providerCode?: string,
  ) {
    super(message);
  }
}
