export class OaError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'OaError';
    this.code = code;
    this.details = details;
  }
}

export function safeError(error) {
  if (error instanceof OaError) return { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) };
  // Never forward raw upstream HTML, request URLs, cookies, credentials, or stack traces.
  return { code: 'INTERNAL_ERROR', message: 'OA 查询失败，请检查本地配置或联系维护人员。' };
}
