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
  AUTH_011: (msg = "Insufficient permissions") =>
    new ApiError(403, "AUTH_011", msg),
  AUTH_012: (
    msg = "Invalid, expired or already used registration invitation",
  ) => new ApiError(400, "AUTH_012", msg),
  AUTH_013: (msg = "An account already exists for this email") =>
    new ApiError(409, "AUTH_013", msg),
  AUTH_014: (
    msg = "This invitation was issued for a different email address",
  ) => new ApiError(403, "AUTH_014", msg),
  AUTH_015: (
    msg = "Verify your email address before accepting this invitation",
  ) => new ApiError(403, "AUTH_015", msg),

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
  APP_006: (msg = "Social provider not enabled for this application") =>
    new ApiError(403, "APP_006", msg),
  APP_007: (msg = "System applications cannot be deleted") =>
    new ApiError(403, "APP_007", msg),

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
  SUB_005: (
    msg = "Self-service plan changes require Stripe to be configured",
  ) => new ApiError(403, "SUB_005", msg),
  SUB_006: (
    msg = "Changing to a paid plan requires a payment, which is not available yet",
  ) => new ApiError(403, "SUB_006", msg),

  // ── CONS ──────────────────────────────────────────────────────────────────
  CONS_001: (msg = "Invalid key format") => new ApiError(400, "CONS_001", msg),
  CONS_002: (msg = "Value must be a finite number") =>
    new ApiError(400, "CONS_002", msg),
  CONS_003: (msg = "User and application combination not found") =>
    new ApiError(404, "CONS_003", msg),
  CONS_004: (msg = "Caller not authorized (requires client_credentials)") =>
    new ApiError(403, "CONS_004", msg),
  CONS_005: (msg = "Invalid consumption identifier", details?: unknown) =>
    new ApiError(400, "CONS_005", msg, details),

  // ── BIL ───────────────────────────────────────────────────────────────────
  BIL_001: (msg = "Billing is not configured") =>
    new ApiError(503, "BIL_001", msg),
  BIL_002: (msg = "Invalid billing configuration") =>
    new ApiError(400, "BIL_002", msg),
  BIL_003: (msg = "Metered usage limit reached") =>
    new ApiError(403, "BIL_003", msg),

  // ── WAL ───────────────────────────────────────────────────────────────────
  WAL_001: (msg = "Wallet account not found") =>
    new ApiError(404, "WAL_001", msg),
  WAL_002: (msg = "Insufficient credit balance", details?: unknown) =>
    new ApiError(402, "WAL_002", msg, details),
  WAL_003: (msg = "Idempotency key already used with different parameters") =>
    new ApiError(409, "WAL_003", msg),
  WAL_004: (msg = "Invalid wallet amount", details?: unknown) =>
    new ApiError(400, "WAL_004", msg, details),
  WAL_005: (msg = "Invalid pagination cursor") =>
    new ApiError(400, "WAL_005", msg),
  WAL_006: (msg = "Online payment is not configured") =>
    new ApiError(503, "WAL_006", msg),
  WAL_007: (msg = "Usage pricing is not configured") =>
    new ApiError(503, "WAL_007", msg),

  // ── USR ───────────────────────────────────────────────────────────────────
  USR_001: (msg = "User not found") => new ApiError(404, "USR_001", msg),
  USR_002: (msg = "Cannot delete the last superadmin") =>
    new ApiError(400, "USR_002", msg),
  USR_003: (msg = "Invalid user data", details?: unknown) =>
    new ApiError(400, "USR_003", msg, details),
  // ── ORG ──────────────────────────────────────────────────────────────────
  ORG_001: (msg = "Organization not found") =>
    new ApiError(404, "ORG_001", msg),
  ORG_002: (msg = "Organization slug already exists") =>
    new ApiError(409, "ORG_002", msg),
  ORG_003: (msg = "Invalid organization data", details?: unknown) =>
    new ApiError(400, "ORG_003", msg, details),
  ORG_004: (msg = "Member not found in organization") =>
    new ApiError(404, "ORG_004", msg),
  ORG_005: (msg = "User is already a member of this organization") =>
    new ApiError(409, "ORG_005", msg),
  // ── SRV ───────────────────────────────────────────────────────────────────
  SRV_001: (msg = "Internal server error") => new ApiError(500, "SRV_001", msg),
  SRV_002: (msg = "Service temporarily unavailable") =>
    new ApiError(503, "SRV_002", msg),
  SRV_003: (msg = "Database error") => new ApiError(500, "SRV_003", msg),
  SRV_004: (msg = "LLM gateway unavailable") =>
    new ApiError(502, "SRV_004", msg),

  // ── MAIL ──────────────────────────────────────────────────────────────────
  MAIL_001: (msg = "Email template not found", details?: unknown) =>
    new ApiError(500, "MAIL_001", msg, details),
  MAIL_002: (msg = "Mail transport failure", details?: unknown) =>
    new ApiError(502, "MAIL_002", msg, details),
  MAIL_003: (msg = "Too many email requests, please retry later") =>
    new ApiError(429, "MAIL_003", msg),

  // ── RATE ──────────────────────────────────────────────────────────────────
  RATE_001: (msg = "Too many authentication attempts, please retry later") =>
    new ApiError(429, "RATE_001", msg),
} as const;
