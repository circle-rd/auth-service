/**
 * Test fixture webapp — Express server
 *
 * A minimal OIDC-RP used as the "protected resource" fixture for Playwright e2e tests.
 *
 * Routes:
 *   GET  /           → landing page (login button when logged-out, claims table when logged-in)
 *   GET  /callback   → handles OAuth authorization code callback
 *   GET  /logout     → clears the session cookie
 *   POST /api/token  → server-side code exchange (keeps client_secret on server)
 *   GET  /api/me     → returns OIDC claims (requires Bearer token or session)
 *
 * Session: simplified HTTP-only cookie storing {accessToken, idToken}.
 * In tests we inspect /api/me with the stored Bearer token.
 */
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import * as jose from "jose";
import * as crypto from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Environment ────────────────────────────────────────────────────────────────
const AUTH_SERVICE_URL = (process.env["AUTH_SERVICE_URL"] ?? "").replace(/\/$/, "");
const AUTH_SERVICE_INTERNAL_URL = (
  process.env["AUTH_SERVICE_INTERNAL_URL"] ?? AUTH_SERVICE_URL
).replace(/\/$/, "");
const APP_SLUG = process.env["APP_SLUG"] ?? "";
const REDIRECT_URI = process.env["REDIRECT_URI"] ?? "";
const PORT = parseInt(process.env["PORT"] ?? "3000", 10);
const SESSION_SECRET = process.env["SESSION_SECRET"] ?? crypto.randomBytes(32).toString("hex");
const CREDENTIALS_PATH = process.env["CREDENTIALS_PATH"] ?? "/shared/credentials.json";

if (!AUTH_SERVICE_URL || !APP_SLUG || !REDIRECT_URI) {
  process.stderr.write("Missing required env vars: AUTH_SERVICE_URL, APP_SLUG, REDIRECT_URI\n");
  process.exit(1);
}

// ── OAuth Credentials ─────────────────────────────────────────────────────────
interface Credentials { clientId: string; clientSecret: string; }

function loadCredentials(): Credentials {
  try {
    return JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf-8")) as Credentials;
  } catch {
    process.stderr.write(`Cannot read credentials from ${CREDENTIALS_PATH}.\n`);
    process.exit(1);
  }
}

const credentials = loadCredentials();

// ── JWKS verification ─────────────────────────────────────────────────────────
type JwksKeySet = ReturnType<typeof jose.createRemoteJWKSet>;
const jwksCache = new Map<string, JwksKeySet>();

function getJwks(): JwksKeySet {
  const jwksUri = `${AUTH_SERVICE_INTERNAL_URL}/api/auth/jwks`;
  if (!jwksCache.has(jwksUri)) {
    jwksCache.set(jwksUri, jose.createRemoteJWKSet(new URL(jwksUri)));
  }
  return jwksCache.get(jwksUri)!;
}

async function verifyToken(token: string): Promise<Record<string, unknown>> {
  const { payload } = await jose.jwtVerify(token, getJwks(), {
    issuer: AUTH_SERVICE_URL,
  });
  return payload as Record<string, unknown>;
}

// ── Simple in-memory session store ────────────────────────────────────────────
interface Session { accessToken: string; idToken?: string; }
const sessions = new Map<string, Session>();

function makeSessionId(): string {
  return crypto.randomBytes(32).toString("hex");
}

// ── Express app ───────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

function serveIndex(res: express.Response, extra?: Record<string, string>): void {
  const template = fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf-8");
  const config = JSON.stringify({
    authServiceUrl: AUTH_SERVICE_URL,
    appSlug: APP_SLUG,
    redirectUri: REDIRECT_URI,
    ...(extra ?? {}),
  });
  const html = template.replace("<!-- CONFIG_PLACEHOLDER -->", `<script>window.__CONFIG__ = ${config};</script>`);
  res.setHeader("Content-Type", "text/html; charset=utf-8").send(html);
}

// Landing page and OAuth callback
app.get("/", (_req, res) => serveIndex(res));
app.get("/callback", (_req, res) => serveIndex(res));

// Logout — clear session
app.get("/logout", (req, res) => {
  const sid = parseCookie(req.headers.cookie ?? "", "sid");
  if (sid) sessions.delete(sid);
  res.setHeader("Set-Cookie", "sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
  res.redirect("/");
});

// Server-side code exchange — client_secret never leaves the server
app.post("/api/token", async (req, res) => {
  const { code, code_verifier, redirect_uri } = req.body as {
    code?: string; code_verifier?: string; redirect_uri?: string;
  };

  if (!code || !code_verifier || !redirect_uri) {
    res.status(400).json({ error: "Missing: code, code_verifier, redirect_uri" });
    return;
  }

  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    code_verifier,
    redirect_uri,
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
  });

  try {
    const tokenRes = await fetch(`${AUTH_SERVICE_INTERNAL_URL}/api/auth/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
    });
    const data = (await tokenRes.json()) as Record<string, unknown>;

    if (tokenRes.ok && data.access_token) {
      // Create a server-side session
      const sid = makeSessionId();
      sessions.set(sid, {
        accessToken: data.access_token as string,
        idToken: data.id_token as string | undefined,
      });
      // Set session cookie in response headers (the client-side JS must relay this)
      data["__sid"] = sid;
    }

    res.status(tokenRes.status).json(data);
  } catch (err) {
    console.error("Token exchange error:", err);
    res.status(502).json({ error: "Token exchange failed" });
  }
});

// Store session sid in cookie (called by client after /api/token)
app.post("/api/session", (req, res) => {
  const { sid } = req.body as { sid?: string };
  if (!sid || !sessions.has(sid)) {
    res.status(400).json({ error: "Invalid sid" });
    return;
  }
  res.setHeader("Set-Cookie", `sid=${sid}; Path=/; HttpOnly; SameSite=Lax`);
  res.json({ ok: true });
});

// /api/me — returns claims; accepts Bearer token or session cookie
app.get("/api/me", async (req, res) => {
  let token: string | undefined;

  const authHeader = req.headers["authorization"];
  if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
    token = authHeader.slice(7);
  } else {
    const sid = parseCookie(req.headers.cookie ?? "", "sid");
    if (sid) {
      token = sessions.get(sid)?.accessToken;
    }
  }

  if (!token) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  try {
    const payload = await verifyToken(token);
    res.json({
      sub: payload["sub"],
      email: payload["email"] ?? null,
      name: payload["name"] ?? null,
      roles: Array.isArray(payload["roles"]) ? payload["roles"] : [],
      permissions: Array.isArray(payload["permissions"]) ? payload["permissions"] : [],
    });
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
});

function parseCookie(cookieHeader: string, name: string): string | undefined {
  for (const part of cookieHeader.split(";")) {
    const [k, v] = part.trim().split("=");
    if (k?.trim() === name) return v?.trim();
  }
  return undefined;
}

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Test fixture webapp started on port ${PORT}`);
});
