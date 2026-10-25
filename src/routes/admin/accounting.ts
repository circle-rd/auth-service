import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAdmin } from "../../middleware.js";
import {
  JOURNAL_KINDS,
  MAX_JOURNAL_WINDOW,
  listJournal,
} from "../../services/accounting-journal.js";

const journalQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    kind: z.enum(JOURNAL_KINDS).optional(),
    userId: z.string().min(1).max(255).optional(),
    applicationId: z.string().uuid().optional(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
  })
  .refine((q) => !q.from || !q.to || q.from < q.to, {
    message: "from must be before to",
    path: ["from"],
  })
  .refine((q) => q.page * q.limit <= MAX_JOURNAL_WINDOW, {
    message: `page * limit must not exceed ${MAX_JOURNAL_WINDOW}; narrow the filters`,
    path: ["page"],
  });

export async function accountingRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  fastify.addHook("preHandler", requireAdmin);

  // GET /api/admin/accounting/journal
  fastify.get("/journal", async (req, reply) => {
    const query = journalQuerySchema.parse(req.query);
    await reply.send(await listJournal(query));
  });
}
