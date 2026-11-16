import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createTestApp } from "../tests/helpers/app.js";
import { ERR } from "../errors.js";
import { generateSshIdentity } from "../services/ssh/crypto.js";

const {
  mockRequireSession,
  mockRequireMachineScope,
  mockSetupTarget,
  mockOwnerDetail,
  mockCreateMetaUser,
  mockListMetaUsers,
  mockDeleteMetaUser,
  mockResolveTarget,
  mockGatewayDetail,
  mockRecordSession,
  mockAssertSchemeValidator,
  mockListKeys,
  mockRegisterKey,
  mockRevokeKey,
  mockResolveRecipientKey,
  mockValidateDevice,
} = vi.hoisted(() => ({
  mockRequireSession: vi.fn(),
  mockRequireMachineScope: vi.fn(),
  mockSetupTarget: vi.fn(),
  mockOwnerDetail: vi.fn(),
  mockCreateMetaUser: vi.fn(),
  mockListMetaUsers: vi.fn(),
  mockDeleteMetaUser: vi.fn(),
  mockResolveTarget: vi.fn(),
  mockGatewayDetail: vi.fn(),
  mockRecordSession: vi.fn(),
  mockAssertSchemeValidator: vi.fn(),
  mockListKeys: vi.fn(),
  mockRegisterKey: vi.fn(),
  mockRevokeKey: vi.fn(),
  mockResolveRecipientKey: vi.fn(),
  mockValidateDevice: vi.fn(),
}));

vi.mock("../middleware.js", () => ({ requireSession: mockRequireSession }));
vi.mock("../services/machine-auth.js", () => ({
  requireMachineScope: mockRequireMachineScope,
}));
vi.mock("../services/resources/scheme-service.js", () => ({
  assertSchemeValidator: mockAssertSchemeValidator,
}));
vi.mock("../services/ssh/targets.js", () => ({
  setupSshTarget: mockSetupTarget,
  getSshOwnerDetail: mockOwnerDetail,
  createSshMetaUser: mockCreateMetaUser,
  listSshMetaUsers: mockListMetaUsers,
  deleteSshMetaUser: mockDeleteMetaUser,
  resolveSshTargetByMetaUser: mockResolveTarget,
  getSshGatewayDetail: mockGatewayDetail,
  recordSshSession: mockRecordSession,
}));
vi.mock("../services/ssh/keys.js", () => ({
  listRecipientKeys: mockListKeys,
  registerRecipientKey: mockRegisterKey,
  revokeRecipientKey: mockRevokeKey,
  resolveRecipientKeyUserId: mockResolveRecipientKey,
}));
vi.mock("../services/ssh/device.js", () => ({
  validateDeviceSession: mockValidateDevice,
}));

const { sshResourceRoutes } = await import("./ssh.js");
const { gatewaySshRoutes } = await import("./gateway-ssh.js");

const APP = "11111111-1111-4111-8111-111111111111";
const RESOURCE = "22222222-2222-4222-8222-222222222222";
const KEY = "33333333-3333-4333-8333-333333333333";

const detail = {
  resourceId: RESOURCE,
  uri: "ssh://22222222-2222-4222-8222-222222222222",
  host: "nuk.local",
  port: 22,
  account: "test",
  publicKey: "ssh-ed25519 AAAA",
  fingerprint: "SHA256:abc",
  authorizedKeysLine: "restrict,pty ssh-ed25519 AAAA auth-service:x",
  validationCommand: "ssh -p 2222 validate-x@gateway.test",
  hostKeyFingerprint: null,
  validatedAt: null,
};

const app = createTestApp();
beforeAll(async () => {
  await app.register(sshResourceRoutes, { prefix: "/api/user" });
  await app.register(gatewaySshRoutes, { prefix: "/api/internal/gateway" });
  await app.ready();
});
afterAll(() => app.close());

beforeEach(() => {
  for (const mock of [
    mockRequireSession,
    mockRequireMachineScope,
    mockSetupTarget,
    mockOwnerDetail,
    mockCreateMetaUser,
    mockListMetaUsers,
    mockDeleteMetaUser,
    mockResolveTarget,
    mockGatewayDetail,
    mockRecordSession,
    mockAssertSchemeValidator,
    mockListKeys,
    mockRegisterKey,
    mockRevokeKey,
    mockResolveRecipientKey,
    mockValidateDevice,
  ]) {
    mock.mockReset();
  }
  mockRequireSession.mockResolvedValue("user-1");
  mockRequireMachineScope.mockResolvedValue({
    clientId: "ssh-gateway",
    scopes: [],
  });
  mockAssertSchemeValidator.mockResolvedValue(undefined);
  mockSetupTarget.mockResolvedValue(detail);
  mockOwnerDetail.mockResolvedValue(detail);
  mockCreateMetaUser.mockResolvedValue({ id: "m1", metaUser: "team-a" });
  mockListMetaUsers.mockResolvedValue([]);
  mockResolveTarget.mockResolvedValue({
    resourceId: RESOURCE,
    resourceUri: "ssh://x",
    applicationId: APP,
    applicationSlug: "share-app",
  });
  mockGatewayDetail.mockResolvedValue({
    ...detail,
    status: "validated",
    applicationId: APP,
    ownerType: "user",
    ownerId: "user-1",
    identity: {
      publicKey: "ssh-ed25519 AAAA",
      privateKeyCiphertext: "v1:x",
      keyVersion: 1,
    },
  });
  mockRecordSession.mockResolvedValue({
    sessionId: "session-1",
    replayed: false,
  });
  mockListKeys.mockResolvedValue([]);
  mockRegisterKey.mockResolvedValue({
    id: KEY,
    publicKey: "ssh-ed25519 AAAA",
    fingerprint: "SHA256:abc",
    label: "laptop",
    createdAt: new Date().toISOString(),
  });
  mockResolveRecipientKey.mockResolvedValue("user-1");
  mockValidateDevice.mockResolvedValue({
    userId: "user-1",
    email: "user@example.com",
    expiresAt: new Date("2026-11-15T13:00:00Z"),
  });
});

describe("SSH user routes", () => {
  it("configures a target", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/api/user/resources/${RESOURCE}/ssh-target`,
      payload: { host: "nuk.local", port: 22, account: "test" },
    });
    expect(res.statusCode).toBe(200);
    expect(mockSetupTarget).toHaveBeenCalledWith(RESOURCE, "user-1", {
      host: "nuk.local",
      port: 22,
      account: "test",
    });
  });

  it("creates a meta-user", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/user/resources/${RESOURCE}/ssh/meta-users`,
      payload: { metaUser: "team-a" },
    });
    expect(res.statusCode).toBe(201);
    expect(mockCreateMetaUser).toHaveBeenCalledWith(
      RESOURCE,
      "user-1",
      "team-a",
    );
  });

  it("registers a recipient key with its proof", async () => {
    const publicKey = generateSshIdentity().publicKey;
    const res = await app.inject({
      method: "POST",
      url: "/api/user/recipient-keys",
      payload: {
        publicKey,
        challenge: "auth-service-ssh-key:x",
        signature: "-----BEGIN SSH SIGNATURE-----",
        label: "laptop",
      },
    });
    expect(res.statusCode).toBe(201);
    expect(mockRegisterKey).toHaveBeenCalledWith(
      "user-1",
      publicKey,
      {
        challenge: "auth-service-ssh-key:x",
        signature: "-----BEGIN SSH SIGNATURE-----",
      },
      "laptop",
    );
  });

  it("refuses a recipient key without a proof", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/user/recipient-keys",
      payload: { publicKey: generateSshIdentity().publicKey },
    });
    expect(res.statusCode).toBe(400);
    expect(mockRegisterKey).not.toHaveBeenCalled();
  });

  it("issues a challenge bound to the key", async () => {
    const identity = generateSshIdentity();
    const res = await app.inject({
      method: "POST",
      url: "/api/user/recipient-keys/challenge",
      payload: { publicKey: identity.publicKey },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().challenge).toContain(identity.fingerprint);
    expect(res.json().namespace).toBe("auth-service");
  });
});

describe("gateway SSH routes", () => {
  it("resolves a meta-user", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/internal/gateway/ssh/targets?metaUser=team-a",
    });
    expect(res.statusCode).toBe(200);
    expect(mockRequireMachineScope).toHaveBeenCalledWith(
      undefined,
      "ssh:target:read",
    );
    expect(mockResolveTarget).toHaveBeenCalledWith("team-a");
  });

  it("resolves a recipient key", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/internal/gateway/ssh/recipient-key",
      payload: { publicKey: `ssh-ed25519 ${"A".repeat(40)}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().userId).toBe("user-1");
  });

  it("returns target detail with a validation subject", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/internal/gateway/ssh/resources/${RESOURCE}?subjectId=user-1`,
    });
    expect(res.statusCode).toBe(200);
    expect(mockGatewayDetail).toHaveBeenCalledWith(RESOURCE, "user-1");
  });

  it("records a session", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/internal/gateway/ssh/sessions",
      payload: {
        resourceId: RESOURCE,
        resourceUri: "ssh://x",
        subjectId: "user-1",
        clientId: "ssh-gateway",
        sessionId: "session-1",
        startedAt: "2026-11-15T12:00:00.000Z",
        endedAt: "2026-11-15T12:01:00.000Z",
        bytesIn: 1,
        bytesOut: 2,
        endReason: "client",
      },
    });
    expect(res.statusCode).toBe(201);
    expect(mockRecordSession).toHaveBeenCalledWith(
      expect.objectContaining({ resourceId: RESOURCE, sessionId: "session-1" }),
    );
    expect(mockAssertSchemeValidator).toHaveBeenCalledWith(
      "ssh",
      "ssh-gateway",
    );
  });

  it("rejects a session report whose client id differs from the token", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/internal/gateway/ssh/sessions",
      payload: {
        resourceId: RESOURCE,
        resourceUri: "ssh://x",
        subjectId: "user-1",
        clientId: "litellm-wallet",
        sessionId: "session-2",
        startedAt: "2026-11-15T12:00:00.000Z",
        endedAt: "2026-11-15T12:01:00.000Z",
        bytesIn: 1,
        bytesOut: 2,
        endReason: "client",
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("AUTH_011");
    expect(mockRecordSession).not.toHaveBeenCalled();
  });

  it("rejects a session report from a non-validator client", async () => {
    mockAssertSchemeValidator.mockRejectedValue(
      ERR.AUTH_011("Client is not the validator for this resource scheme"),
    );
    const res = await app.inject({
      method: "POST",
      url: "/api/internal/gateway/ssh/sessions",
      payload: {
        resourceId: RESOURCE,
        resourceUri: "ssh://x",
        subjectId: "user-1",
        clientId: "ssh-gateway",
        sessionId: "session-3",
        startedAt: "2026-11-15T12:00:00.000Z",
        endedAt: "2026-11-15T12:01:00.000Z",
        bytesIn: 1,
        bytesOut: 2,
        endReason: "client",
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("AUTH_011");
    expect(mockRecordSession).not.toHaveBeenCalled();
  });

  it("validates a device session", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/internal/gateway/device/session",
      payload: { sessionToken: "token" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().userId).toBe("user-1");
    expect(mockRequireMachineScope).toHaveBeenCalledWith(
      undefined,
      "device:session:validate",
    );
  });
});
