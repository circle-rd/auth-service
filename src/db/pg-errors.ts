/** Whether a query failed on a unique constraint (SQLSTATE 23505). */
export function isUniqueViolation(err: unknown): boolean {
  const code = (value: unknown) =>
    typeof value === "object" && value !== null && "code" in value
      ? (value as { code?: unknown }).code
      : undefined;
  // Drizzle wraps the driver error and keeps it as `cause`.
  return (
    code(err) === "23505" ||
    code((err as { cause?: unknown } | null)?.cause) === "23505"
  );
}
