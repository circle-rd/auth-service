import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "../../db/index.js";
import { ERR } from "../../errors.js";
import {
  getActorUserId,
  getRequestSession,
  requireAdmin,
} from "../../middleware.js";
import { sendRegistrationInvitationEmail } from "../../services/email.js";
import { isMailConfigured } from "../../services/mail/index.js";
import {
  INVITATION_TTL_HOURS,
  buildInvitationUrl,
  createRegistrationInvitation,
  getRegistrationInvitation,
  listRegistrationInvitations,
  revokeRegistrationInvitation,
  toPublicInvitation,
  type PublicRegistrationInvitation,
  type RegistrationInvitation,
} from "../../services/registration-invitations.js";

const createInvitationSchema = z.object({
  email: z.string().trim().email().max(320),
  applicationId: z.string().uuid(),
});

/** Optional `limit`/`offset` query values; non-numeric input is ignored. */
function parsePageParam(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

export async function registrationInvitationRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  fastify.addHook("preHandler", requireAdmin);

  /**
   * Build the redemption link and send the email. Kept out of the creation
   * transaction: a slow or failing SMTP call must not hold a database lock, and
   * the two handlers share this exact logic.
   */
  async function deliverInvitation(args: {
    invitation: RegistrationInvitation;
    token: string;
    applicationSlug: string;
    inviterName?: string;
  }): Promise<{
    invitation: PublicRegistrationInvitation;
    inviteUrl: string;
    emailSent: boolean;
  }> {
    const inviteUrl = buildInvitationUrl(args.applicationSlug, args.token);
    let emailSent = false;
    if (isMailConfigured()) {
      await sendRegistrationInvitationEmail(
        args.invitation.email,
        {
          url: inviteUrl,
          expiresInHours: INVITATION_TTL_HOURS,
          inviterName: args.inviterName,
        },
        args.applicationSlug,
      );
      emailSent = true;
    }
    // `inviteUrl` is returned once so an administrator can hand it over when
    // mail is not configured. The token is stored only as a hash.
    return {
      invitation: toPublicInvitation(args.invitation),
      inviteUrl,
      emailSent,
    };
  }

  // POST /api/admin/registration-invitations — invite one email to one application.
  fastify.post("/", async (req, reply) => {
    const parsed = createInvitationSchema.safeParse(req.body);
    if (!parsed.success) throw ERR.USR_003("Invalid invitation data");

    const actorUserId = await getActorUserId(req);
    if (!actorUserId) throw ERR.AUTH_001();
    const session = await getRequestSession(req);

    const created = await createRegistrationInvitation({
      email: parsed.data.email,
      applicationId: parsed.data.applicationId,
      invitedByUserId: actorUserId,
    });

    return reply.status(201).send(
      await deliverInvitation({
        invitation: created.invitation,
        token: created.token,
        applicationSlug: created.applicationSlug,
        inviterName: session?.user.name,
      }),
    );
  });

  // GET /api/admin/registration-invitations?applicationId=&limit=&offset=
  fastify.get<{
    Querystring: { applicationId?: string; limit?: string; offset?: string };
  }>("/", async (req, reply) => {
    const invitations = await listRegistrationInvitations({
      applicationId: req.query.applicationId,
      limit: parsePageParam(req.query.limit),
      offset: parsePageParam(req.query.offset),
    });
    return reply.send({ invitations: invitations.map(toPublicInvitation) });
  });

  // DELETE /api/admin/registration-invitations/:id — revoke a pending invitation.
  fastify.delete<{ Params: { id: string } }>("/:id", async (req, reply) => {
    const revoked = await revokeRegistrationInvitation(req.params.id);
    return reply.send({ invitation: toPublicInvitation(revoked) });
  });

  // POST /api/admin/registration-invitations/:id/resend — replace with a fresh one.
  // Only the token hash is stored, so a resend issues a new token and voids the
  // previous pending link. The revoke and the reissue share one transaction:
  // if the replacement cannot be created, the old link stays valid.
  fastify.post<{ Params: { id: string } }>(
    "/:id/resend",
    async (req, reply) => {
      const existing = await getRegistrationInvitation(req.params.id);
      if (!existing) throw ERR.AUTH_012("Invitation not found");

      const actorUserId = await getActorUserId(req);
      if (!actorUserId) throw ERR.AUTH_001();
      const session = await getRequestSession(req);

      const created = await db.transaction(async (tx) => {
        if (!existing.consumedAt && !existing.revokedAt) {
          await revokeRegistrationInvitation(existing.id, tx);
        }
        return createRegistrationInvitation(
          {
            email: existing.email,
            applicationId: existing.applicationId,
            invitedByUserId: actorUserId,
          },
          tx,
        );
      });

      return reply.status(201).send(
        await deliverInvitation({
          invitation: created.invitation,
          token: created.token,
          applicationSlug: created.applicationSlug,
          inviterName: session?.user.name,
        }),
      );
    },
  );
}
