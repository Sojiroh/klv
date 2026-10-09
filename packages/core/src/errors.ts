export class KubeError extends Error {
  constructor(message: string, readonly statusCode?: number) {
    super(message);
    this.name = 'KubeError';
  }
}
