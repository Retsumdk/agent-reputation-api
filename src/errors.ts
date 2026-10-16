export type ErrorCode =
  | "VALIDATION"
  | "NOT_FOUND"
  | "DUPLICATE"
  | "REPLAY"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "RATE_LIMITED"
  | "CORRUPTION"
  | "INTERNAL";

const STATUS: Record<ErrorCode, number> = {
  VALIDATION: 400,
  NOT_FOUND: 404,
  DUPLICATE: 409,
  REPLAY: 409,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  RATE_LIMITED: 429,
  CORRUPTION: 500,
  INTERNAL: 500,
};

export class ReputationError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "ReputationError";
    this.code = code;
  }

  get status(): number {
    return STATUS[this.code];
  }

  toJSON(): { code: ErrorCode; message: string } {
    return { code: this.code, message: this.message };
  }
}

export const ERROR_STATUS: Readonly<Record<ErrorCode, number>> = STATUS;

export function isReputationError(err: unknown): err is ReputationError {
  return err instanceof ReputationError;
}
