export type SafePlaidError = {
  code: string;
  message: string;
  statusCode?: number;
  plaidRequestId?: string;
};

export class PlaidAdapterError extends Error {
  readonly safe: SafePlaidError;

  constructor(safe: SafePlaidError) {
    super(safe.message);
    this.name = "PlaidAdapterError";
    this.safe = safe;
  }
}

export function toPlaidAdapterError(error: unknown, fallbackCode: string): PlaidAdapterError {
  if (error instanceof PlaidAdapterError) return error;

  const response = isRecord(error) && isRecord(error.response) ? error.response : undefined;
  const responseData = isRecord(response?.data) ? response.data : undefined;
  const statusCode = typeof response?.status === "number" ? response.status : undefined;
  const plaidCode = typeof responseData?.error_code === "string" ? responseData.error_code : fallbackCode;
  const requestId = typeof responseData?.request_id === "string" ? responseData.request_id : undefined;

  return new PlaidAdapterError({
    code: plaidCode,
    message: "Plaid Sandbox request failed.",
    statusCode,
    plaidRequestId: requestId,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
