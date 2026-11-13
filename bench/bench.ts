// Bench harness for the auth hot paths (plan P0).
//
// Two server lives, driven entirely from here:
//   life 1 (LOG_SQL off) — throughput and latency per scenario under
//   concurrency;
//   life 2 (LOG_SQL on)  — a quiet sequential pass to count SQL statements
//   per request.
//
// Usage:
//   pnpm bench [--reps N] [--concurrency N]
//              [--scenarios health,jwks,session,machine]
//              [--perf-only | --count-only]
//              [--base-url URL] — targets an already-running instance and only
//              exercises the read-only scenarios there (no machine minting).
//
// Results land in bench/results/report.json (untracked).

import "dotenv/config";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";

interface Options {
  baseUrl?: string;
  reps: number;
  concurrency: number;
  maxRps?: number;
  scenarios: string[];
  countOnly: boolean;
  perfOnly: boolean;
}

interface Stats {
  durationMs: number;
  total: number;
  errors: number;
  statuses: Record<number, number>;
  rps: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
}

interface MachineCredentials {
  slug: string;
  secret: string;
  resource: string;
  userId: string;
}

interface Seed {
  adminCookie: string;
  machine: MachineCredentials | null;
}

interface ServerHandle {
  child: ChildProcess;
  logLines: string[];
}

const MACHINE_MAX_RPS = 60; // internal gateway bucket caps at 6000/min/IP.
const SCENARIOS = ["health", "jwks", "session", "machine"] as const;
const MACHINE_SCOPES = [
  "m2m",
  "wallet:read",
  "billing:read",
  "consumption:read",
  "consumption:write",
];
const COUNT_REPS = 5;

const options = parseFlags();
const live = Boolean(options.baseUrl);
const base = (
  options.baseUrl ?? `http://localhost:${process.env.PORT ?? "3001"}`
).replace(/\/$/, "");

main().catch((err) => {
  console.error("[bench]", err);
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const resultsDir = "bench/results";
  mkdirSync(resultsDir, { recursive: true });

  const perfScenarios = options.countOnly
    ? []
    : live
      ? options.scenarios.filter((name) => name !== "machine")
      : options.scenarios;
  if (live && options.scenarios.includes("machine")) {
    console.warn(
      "[bench] machine scenario skipped against a live instance: minting machine credentials would write there",
    );
  }
  const runCounting = !options.perfOnly && !live;
  if (live && (runCounting === false) === options.perfOnly) {
    console.warn(
      "[bench] SQL counting runs only against the locally spawned build",
    );
  }

  const perf: Record<string, Stats> = {};
  let seed: Seed | null = null;
  const server = live
    ? null
    : spawnServer(join(resultsDir, "server-perf.log"), false);
  try {
    await waitReady(base, server ?? undefined);
    if (perfScenarios.length > 0 || (runCounting && !live)) {
      seed = await seedInstance(base);
    }
    for (const name of perfScenarios) {
      perf[name] = await runScenario(
        name,
        seed!,
        options.concurrency,
        options.reps,
      );
      console.warn(`[bench] ${name}: done`);
    }
  } finally {
    if (server) await stopServer(server);
  }

  const counts: Record<string, number> = {};
  if (runCounting) {
    const server = spawnServer(join(resultsDir, "server-count.log"), true);
    try {
      await waitReady(base, server ?? undefined);
      seed = await seedInstance(base);
      if (options.scenarios.includes("session")) {
        counts.session = await countScenario(server, "session", seed);
      }
      if (options.scenarios.includes("machine") && seed.machine) {
        counts.machine = await countScenario(server, "machine", seed);
      }
    } finally {
      await stopServer(server);
    }
  }

  const report = { base, scenarios: perf, sqlPerRequest: counts };
  writeFileSync(
    join(resultsDir, "report.json"),
    JSON.stringify(report, null, 2),
  );
  renderReport(report);
}

function parseFlags(): Options {
  const args = process.argv.slice(2);
  const value = new Map<string, string>();
  for (let i = 0; i < args.length; i += 1) {
    if (args[i]!.startsWith("--")) {
      value.set(args[i]!.slice(2), args[i + 1] ?? "");
    }
  }
  const scenariosArg = value.get("scenarios");
  return {
    baseUrl: value.get("base-url"),
    reps: Number(value.get("reps") ?? 300),
    concurrency: Number(value.get("concurrency") ?? 20),
    maxRps: value.get("max-rps") ? Number(value.get("max-rps")) : undefined,
    scenarios: SCENARIOS.filter((name) =>
      (scenariosArg ?? SCENARIOS.join(",")).split(",").includes(name),
    ),
    countOnly: args.includes("--count-only"),
    perfOnly: args.includes("--perf-only"),
  };
}

function spawnServer(logFile: string, logSql: boolean): ServerHandle {
  const logLines: string[] = [];
  const child = spawn(process.execPath, ["dist/index.js"], {
    // The per-IP global guard (600/min by default) would truncate the
    // scenarios; the bench measures the request paths, not the guard.
    env: {
      ...process.env,
      LOG_SQL: logSql ? "true" : "false",
      RATE_LIMIT_GLOBAL_MAX: "200000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const capture = (chunk: Buffer): void => {
    for (const line of chunk.toString().split("\n")) {
      if (line.trim()) {
        logLines.push(line);
        appendFileSync(logFile, line + "\n");
      }
    }
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);
  return { child, logLines };
}

async function stopServer(server: ServerHandle): Promise<void> {
  server.child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      server.child.kill("SIGKILL");
      void resolve();
    }, 5_000);
    server.child.on("exit", () => {
      clearTimeout(timer);
      void resolve();
    });
  });
}

// A server that never binds (port taken by a stray instance) makes every
// measurement hit the wrong process, so this must fail loudly.
assertNoStrayServer();

function assertNoStrayServer(): void {
  if (!existsSync("/proc/net/tcp") && !existsSync("/proc/net/tcp6")) return;
  // /proc/net/tcp prints the port in upper-case hexadecimal.
  const portBytes = Number(process.env.PORT ?? 3001)
    .toString(16)
    .toUpperCase()
    .padStart(4, "0");
  for (const path of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    const lines = readFileSync(path, "utf8").split("\n").slice(1);
    for (const line of lines) {
      const columns = line.trim().split(/\s+/);
      if (columns[1]?.endsWith(`:${portBytes}`) && columns[3] === "0A") {
        throw new Error(
          `port ${process.env.PORT ?? 3001} is already bound — stop the stray server first`,
        );
      }
    }
  }
}

// Readiness is only meaningful for the process we spawned: if it exited (for
// example EADDRINUSE because another server holds the port), fail instead of
// measuring whatever answers on that port.
async function waitReady(target: string, server?: ServerHandle): Promise<void> {
  const deadline = Date.now() + 90_000;
  for (;;) {
    if (server && server.child.exitCode !== null) {
      throw new Error(
        `spawned server exited with code ${server.child.exitCode}; see its log`,
      );
    }
    try {
      const res = await fetch(`${target}/health`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (res.ok) return;
    } catch {
      // The server is not listening yet.
    }
    if (Date.now() > deadline) {
      throw new Error(`server at ${target} did not become ready`);
    }
    await sleep(500);
  }
}

async function request(
  target: string,
  path: string,
  init: RequestInit,
): Promise<{
  status: number;
  headers: Headers;
  body: string;
  durationMs: number;
}> {
  const started = process.hrtime.bigint();
  const res = await fetch(`${target}${path}`, {
    ...init,
    keepalive: true,
    signal: AbortSignal.timeout(15_000),
  });
  const body = await res.text();
  return {
    status: res.status,
    headers: res.headers,
    body,
    durationMs: msSince(started),
  };
}

function msSince(started: bigint): number {
  return Number(process.hrtime.bigint() - started) / 1e6;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readCookies(headers: Headers): string {
  return headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0]!)
    .filter(Boolean)
    .join("; ");
}

async function seedInstance(target: string): Promise<Seed> {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) {
    throw new Error("ADMIN_EMAIL/ADMIN_PASSWORD must be set for the bench");
  }

  const signIn = await request(target, "/api/auth/sign-in/email", {
    method: "POST",
    // BetterAuth rejects a missing/null Origin on POSTs; identify as the
    // instance origin.
    headers: { "content-type": "application/json", origin: target },
    body: JSON.stringify({ email, password }),
  });
  if (signIn.status !== 200) {
    throw new Error(
      `admin sign-in failed (${signIn.status}): ${signIn.body} — bootstrap the superadmin first`,
    );
  }
  const adminCookie = readCookies(signIn.headers);

  const sessionRes = await request(target, "/api/auth/get-session", {
    headers: { cookie: adminCookie },
  });
  if (sessionRes.status !== 200) {
    throw new Error(`get-session failed (${sessionRes.status})`);
  }
  const session = JSON.parse(sessionRes.body) as { user: { id: string } };

  // The instance stays read-only under a --base-url run: machine credentials
  // cannot be minted there, so its machine scenario is skipped.
  if (live) return { adminCookie, machine: null };

  const create = await request(target, "/api/admin/applications", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: adminCookie,
      origin: target,
    },
    body: JSON.stringify({
      name: "bench machine",
      slug: `bench-machine-${Date.now()}`,
      description: "bench, safe to delete",
      isPublic: false,
      skipConsent: true,
      // Registering the instance URL as the application's protected resource
      // makes client_credentials tokens RFC 8707 JWTs — the same shape the
      // LiteLLM gateway verifies in production.
      url: target,
    }),
  });
  if (create.status !== 200 && create.status !== 201) {
    throw new Error(
      `application creation failed (${create.status}): ${create.body}`,
    );
  }
  const created = JSON.parse(create.body) as {
    application: { id: string };
    clientId: string;
    clientSecret: string;
  };
  if (!created.clientSecret) throw new Error("no client secret returned");

  const scopes = await request(
    target,
    `/api/admin/applications/${created.application.id}/machine-scopes`,
    {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        cookie: adminCookie,
        origin: target,
      },
      body: JSON.stringify({ scopes: MACHINE_SCOPES }),
    },
  );
  if (scopes.status !== 200) {
    throw new Error(`machine-scopes update failed (${scopes.status})`);
  }
  return {
    adminCookie,
    machine: {
      slug: created.clientId,
      secret: created.clientSecret,
      resource: target,
      userId: session.user.id,
    },
  };
}

function scenarioRequest(
  name: string,
  seed: Seed,
): { init: RequestInit; url: string } {
  if (name === "health") return { url: `${base}/health`, init: {} };
  if (name === "jwks") return { url: `${base}/api/auth/jwks`, init: {} };
  if (name === "session") {
    return {
      url: `${base}/api/user/sessions`,
      init: { headers: { cookie: seed.adminCookie } },
    };
  }
  if (name === "machine") {
    if (!seed.machine) {
      throw new Error("machine scenario needs machine credentials");
    }
    const { userId, slug } = seed.machine;
    return {
      url: `${base}/api/internal/gateway/users/${userId}/plan?applicationSlug=${slug}`,
      init: {},
    };
  }
  throw new Error(`unknown scenario: ${name}`);
}

async function runScenario(
  name: string,
  seed: Seed,
  concurrency: number,
  reps: number,
): Promise<Stats> {
  let authorization: string | null = null;
  if (name === "machine") {
    if (!seed.machine) {
      throw new Error("machine scenario needs machine credentials");
    }
    authorization = await issueMachineToken(base, seed.machine);
  }

  const globalPaceMs = options.maxRps
    ? (concurrency * 1000) / options.maxRps
    : 0;
  // The internal gateway bucket caps at 6000/min/IP: keep the machine
  // scenario under it even without an explicit --max-rps.
  const perWorkerPaceMs =
    name === "machine" ? (concurrency * 1000) / MACHINE_MAX_RPS : globalPaceMs;

  const durations: number[] = [];
  let errors = 0;
  const statuses: Record<number, number> = {};
  const tally = (status: number): void => {
    statuses[status] = (statuses[status] ?? 0) + 1;
  };
  const perWorker = Math.floor(reps / concurrency);
  const remainder = reps % concurrency;

  const startedAll = process.hrtime.bigint();
  await Promise.all(
    Array.from({ length: concurrency }, async (_unused, worker) => {
      const count = perWorker + (worker < remainder ? 1 : 0);
      for (let i = 0; i < count; i += 1) {
        if (perWorkerPaceMs) await sleep(perWorkerPaceMs);
        const { url, init } = scenarioRequest(name, seed);
        const headers = init.headers as Record<string, string> | undefined;
        if (name === "machine" && authorization) {
          init.headers = {
            ...headers,
            authorization: `Bearer ${authorization}`,
          };
        }
        const before = process.hrtime.bigint();
        const status = await fetch(url, {
          ...init,
          keepalive: true,
          signal: AbortSignal.timeout(15_000),
        }).then(
          async (res) => {
            await res.arrayBuffer();
            return res.status;
          },
          () => -1,
        );
        const durationMs = msSince(before);
        tally(status);
        if (status === 200) durations.push(durationMs);
        else errors += 1;
      }
    }),
  );
  const elapsedMs = msSince(startedAll);
  return summarize(durations, errors, elapsedMs, statuses);
}
async function issueMachineToken(
  target: string,
  machine: MachineCredentials,
): Promise<string> {
  const basic = Buffer.from(`${machine.slug}:${machine.secret}`).toString(
    "base64",
  );
  const res = await request(target, "/api/auth/oauth2/token", {
    method: "POST",
    headers: {
      authorization: `Basic ${basic}`,
      "content-type": "application/x-www-form-urlencoded",
      origin: target,
    },
    body: `grant_type=client_credentials&resource=${encodeURIComponent(machine.resource)}`,
  });
  if (res.status !== 200) throw new Error(`token grant failed (${res.status})`);
  const body = JSON.parse(res.body) as { access_token: string };
  return body.access_token;
}

function isSql(line: string): boolean {
  return line.startsWith("Query: ");
}

async function countScenario(
  server: ServerHandle,
  name: string,
  seed: Seed,
): Promise<number> {
  let authorization: string | null = null;
  if (name === "machine") {
    if (!seed.machine) return 0;
    authorization = await issueMachineToken(base, seed.machine);
  }
  const sqlBefore = server.logLines.filter(isSql).length;
  for (let i = 0; i < COUNT_REPS; i += 1) {
    const { url, init } = scenarioRequest(name, seed);
    const headers = init.headers as Record<string, string> | undefined;
    if (name === "machine" && authorization) {
      init.headers = { ...headers, authorization: `Bearer ${authorization}` };
    }
    const res = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(15_000),
    });
    await res.arrayBuffer();
    if (res.status !== 200) {
      throw new Error(
        `counting pass got ${res.status} on ${name} request ${i + 1}`,
      );
    }
  }
  // The server's query log arrives via asynchronously delivered stdout
  // chunks; give the event loop a moment before snapshotting.
  await sleep(500);
  const sqlAfter = server.logLines.filter(isSql).length;
  return (sqlAfter - sqlBefore) / COUNT_REPS;
}

function summarize(
  durations: number[],
  errors: number,
  elapsedMs: number,
  statuses: Record<number, number>,
): Stats {
  const sorted = [...durations].sort((a, b) => a - b);
  const pick = (q: number): number =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0;
  const sum = durations.reduce((acc, value) => acc + value, 0);
  const total = durations.length + errors;
  return {
    durationMs: Math.round(elapsedMs),
    total,
    errors,
    statuses,
    rps: elapsedMs > 0 ? Math.round((total / elapsedMs) * 1000) : 0,
    mean: durations.length ? sum / durations.length : 0,
    p50: pick(0.5),
    p95: pick(0.95),
    p99: pick(0.99),
  };
}

function renderReport(report: {
  base: string;
  scenarios: Record<string, Stats>;
  sqlPerRequest: Record<string, number>;
}): void {
  console.log(`\nBench report — ${report.base}`);
  console.log("scenario  rps  mean  p50  p95  p99  errors  statuses");
  for (const [name, stats] of Object.entries(report.scenarios)) {
    const statusList = Object.entries(stats.statuses)
      .map(([code, count]) => `${code}x${count}`)
      .join(" ");
    console.log(
      `${name.padEnd(8)} ${stats.rps} ${stats.mean.toFixed(1)} ${stats.p50.toFixed(1)} ${stats.p95.toFixed(1)} ${stats.p99.toFixed(1)} ${stats.errors} ${statusList}`,
    );
  }
  for (const [name, sql] of Object.entries(report.sqlPerRequest)) {
    console.log(`sql/req ${name}: ${sql}`);
  }
  if (Object.keys(report.sqlPerRequest).length === 0) {
    console.log("sql/req: not measured (use --count-only or the default mode)");
  }
}
