import { afterEach, describe, expect, it, vi } from "vitest";
import {
  exportGatewayConfig,
  importGatewayConfig,
  planModelImport,
  toExportModel,
} from "./litellm-config-lib.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("toExportModel", () => {
  it("drops the provider key and the ids the gateway assigns", () => {
    expect(
      toExportModel({
        model_name: "gpt",
        litellm_params: {
          model: "openai/gpt",
          api_key: "sk-secret",
          litellm_credential_name: "provider",
        },
        model_info: { id: "abc", db_model: true, mode: "chat" },
      }),
    ).toEqual({
      model_name: "gpt",
      litellm_params: {
        model: "openai/gpt",
        litellm_credential_name: "provider",
      },
      model_info: { mode: "chat" },
    });
  });

  it("drops every known provider secret and URL-embedded credentials", () => {
    expect(
      toExportModel({
        model_name: "bedrock",
        litellm_params: {
          model: "bedrock/anthropic.claude",
          aws_secret_access_key: "secret",
          aws_session_token: "session",
          api_base: "https://user:pass@host/v1",
        },
      }),
    ).toEqual({
      model_name: "bedrock",
      litellm_params: {
        model: "bedrock/anthropic.claude",
        api_base: "https://host/v1",
      },
    });
  });

  it("omits model_info when nothing survives", () => {
    expect(
      toExportModel({
        model_name: "gpt",
        litellm_params: { model: "openai/gpt" },
        model_info: { id: "abc", db_model: true },
      }),
    ).toEqual({ model_name: "gpt", litellm_params: { model: "openai/gpt" } });
  });
});

describe("planModelImport", () => {
  it("classifies a model as update when deployed, create otherwise", () => {
    const actions = planModelImport(
      [{ model_name: "gpt", model_info: { id: "abc" } }],
      [
        { model_name: "gpt", litellm_params: {} },
        { model_name: "claude", litellm_params: {} },
      ],
    );
    expect(actions.map((a) => a.kind)).toEqual(["update", "create"]);
    expect(actions[0]!.id).toBe("abc");
  });
});

interface Call {
  method: string;
  path: string;
  body: unknown;
}

function stubGateway(responses: Array<{ status: number; json: unknown }>) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({
        method: init.method ?? "GET",
        path: url.replace("http://gw:4000", ""),
        body: init.body ? JSON.parse(init.body as string) : undefined,
      });
      const next = responses.shift() ?? { status: 200, json: {} };
      const body = next.json === null ? null : JSON.stringify(next.json);
      return new Response(body, { status: next.status });
    }),
  );
  return calls;
}

const client = { base: "http://gw:4000", masterKey: "sk-master" };

describe("exportGatewayConfig", () => {
  it("reads models and access groups, stripping the group id", async () => {
    stubGateway([
      {
        status: 200,
        json: {
          data: [
            {
              model_name: "gpt",
              litellm_params: { model: "openai/gpt", api_key: "sk" },
              model_info: { id: "abc", mode: "chat" },
            },
          ],
        },
      },
      {
        status: 200,
        json: {
          access_groups: [
            {
              access_group_id: "g1",
              access_group_name: "app:free",
              access_model_names: ["gpt"],
            },
          ],
        },
      },
    ]);
    expect(await exportGatewayConfig(client)).toEqual({
      models: [
        {
          model_name: "gpt",
          litellm_params: { model: "openai/gpt" },
          model_info: { mode: "chat" },
        },
      ],
      access_groups: [
        { access_group_name: "app:free", access_model_names: ["gpt"] },
      ],
    });
  });
});

describe("importGatewayConfig", () => {
  it("creates missing models and groups, updates existing ones", async () => {
    const calls = stubGateway([
      // GET /model/info
      {
        status: 200,
        json: {
          data: [
            {
              model_name: "gpt",
              litellm_params: {},
              model_info: { id: "abc" },
            },
          ],
        },
      },
      // POST /model/update
      { status: 200, json: {} },
      // POST /model/new
      { status: 201, json: {} },
      // GET /v1/access_group
      {
        status: 200,
        json: {
          access_groups: [
            { access_group_id: "g1", access_group_name: "app:free" },
          ],
        },
      },
      // PUT /v1/access_group/g1
      { status: 200, json: {} },
      // POST /v1/access_group
      { status: 201, json: {} },
    ]);
    const report = await importGatewayConfig(client, {
      models: [
        { model_name: "gpt", litellm_params: { model: "openai/gpt" } },
        { model_name: "claude", litellm_params: { model: "anthropic/claude" } },
      ],
      access_groups: [
        { access_group_name: "app:free", access_model_names: ["gpt"] },
        { access_group_name: "app:premium" },
      ],
    });
    expect(report).toEqual({
      modelsCreated: ["claude"],
      modelsUpdated: ["gpt"],
      groupsCreated: ["app:premium"],
      groupsUpdated: ["app:free"],
    });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /model/info",
      "POST /model/update",
      "POST /model/new",
      "GET /v1/access_group",
      "PUT /v1/access_group/g1",
      "POST /v1/access_group",
    ]);
    expect(calls[1]!.body).toEqual({
      model_name: "gpt",
      litellm_params: { model: "openai/gpt" },
      model_info: { id: "abc" },
    });
  });
});
