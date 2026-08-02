export class ThreadsAPIError extends Error {
  readonly data?: unknown;
  readonly status?: number;

  constructor(message: string, data?: unknown, status?: number) {
    super(message);
    this.name = 'ThreadsAPIError';
    this.data = data;
    this.status = status;
  }
}

export class DocIdNotFoundError extends ThreadsAPIError {
  constructor(operation: string) {
    super(
      `No GraphQL doc_id found for operation "${operation}". Run discoverDocIds() or update seed-doc-ids.json.`,
    );
    this.name = 'DocIdNotFoundError';
  }
}
