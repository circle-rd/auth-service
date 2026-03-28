export interface ApiErrorBody {
  code: string;
  message: string;
  details?: unknown;
}

export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }

  toJSON(): { error: ApiErrorBody } {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details !== undefined ? { details: this.details } : {}),
      },
    };
  }
}

// ── AUTH ────────────────────────────────────────────────────────────────────
export const ERR = {
  AUTH_001: (msg = "Missing or invalid authentication token") =>
    new ApiError(401, "AUTH_001", msg),
  AUTH_002: (msg = "Token expired") => new ApiError(401, "AUTH_002", msg),
  AUTH_003: (msg = "Invalid credentials") => new ApiError(401, "AUTH_003", msg),
  AUTH_004: (msg = "MFA required") => new ApiError(401, "AUTH_004", msg),
  AUTH_005: (msg = "Invalid MFA code") => new ApiError(401, "AUTH_005", msg),
  AUTH_006: (msg = "Account disabled") => new ApiError(403, "AUTH_006", msg),
  AUTH_007: (msg = "Too many login attempts") =>
    new ApiError(429, "AUTH_007", msg),
  AUTH_008: (msg = "Invalid or expired password reset token") =>
    new ApiError(400, "AUTH_008", msg),
  AUTH_009: (msg = "Password too weak") => new ApiError(400, "AUTH_009", msg),
  AUTH_010: (msg = "Email already registered") =>
    new ApiError(409, "AUTH_010", msg),

  // ── APP ───────────────────────────────────────────────────────────────────
  APP_001: (msg = "Invalid application data", details?: unknown) =>
    new ApiError(400, "APP_001", msg, details),
  APP_002: (msg = "Application not found") => new ApiError(404, "APP_002", msg),
  APP_003: (msg = "Application slug already exists") =>
    new ApiError(409, "APP_003", msg),
  APP_004: (msg = "Cannot delete application with active users") =>
    new ApiError(400, "APP_004", msg),
  APP_005: (msg = "User does not have access to this application") =>
    new ApiError(403, "APP_005", msg),

  // ── PERM ──────────────────────────────────────────────────────────────────
  PERM_001: (msg = "Invalid permission format") =>
    new ApiError(400, "PERM_001", msg),
  PERM_002: (msg = "Role not found") => new ApiError(404, "PERM_002", msg),
  PERM_003: (msg = "Permission not found") =>
    new ApiError(404, "PERM_003", msg),
  PERM_004: (msg = "Role name already exists in this application") =>
    new ApiError(409, "PERM_004", msg),
  PERM_005: (msg = "Permission already defined") =>
    new ApiError(409, "PERM_005", msg),
  PERM_006: (msg = "Cannot delete role assigned to active users") =>
    new ApiError(400, "PERM_006", msg),

  // ── SUB ───────────────────────────────────────────────────────────────────
  SUB_001: (msg = "Subscription plan not found") =>
    new ApiError(404, "SUB_001", msg),
  SUB_002: (msg = "User already has an active subscription") =>
    new ApiError(409, "SUB_002", msg),
  SUB_003: (msg = "Plan has active subscribers, cannot delete") =>
    new ApiError(400, "SUB_003", msg),
  SUB_004: (msg = "Subscription expired") => new ApiError(400, "SUB_004", msg),

  // ── CONS ──────────────────────────────────────────────────────────────────
  CONS_001: (msg = "Invalid key format") => new ApiError(400, "CONS_001", msg),
  CONS_002: (msg = "Value must be a finite number") =>
    new ApiError(400, "CONS_002", msg),
  CONS_003: (msg = "User and application combination not found") =>
    new ApiError(404, "CONS_003", msg),
  CONS_004: (msg = "Consumption record not found") =>
    new ApiError(404, "CONS_004", msg),

  // ── USR ───────────────────────────────────────────────────────────────────
  USR_001: (msg = "User not found") => new ApiError(404, "USR_001", msg),
  USR_002: (msg = "Cannot delete the last superadmin") =>
    new ApiError(400, "USR_002", msg),
  USR_003: (msg = "Invalid user data", details?: unknown) =>
    new ApiError(400, "USR_003", msg, details),

  // ── SRV ───────────────────────────────────────────────────────────────────
  SRV_001: (msg = "Internal server error") => new ApiError(500, "SRV_001", msg),
  SRV_002: (msg = "Service temporarily unavailable") =>
    new ApiError(503, "SRV_002", msg),
  SRV_003: (msg = "Database error") => new ApiError(500, "SRV_003", msg),
} as const;
