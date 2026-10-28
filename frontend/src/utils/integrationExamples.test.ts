import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import {
  ioserverExample,
  litellmPythonExample,
  litellmTypescriptExample,
  pythonExample,
  typescriptExample,
  type ExampleApplication,
} from './integrationExamples';

const ISSUER = 'https://auth.example.com';

const base: ExampleApplication = {
  slug: 'acme-app',
  url: 'https://app.acme.com',
  redirectUris: ['https://app.acme.com/callback'],
  allowedScopes: ['openid', 'profile', 'offline_access'],
  isPublic: false,
  enableEndSession: true,
  postLogoutRedirectUris: ['https://app.acme.com/'],
  backchannelLogoutUri: null,
};

const syntaxErrors = (code: string): string[] =>
  ts
    .transpileModule(code, {
      reportDiagnostics: true,
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    })
    .diagnostics!.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));

describe('typescriptExample', () => {
  it('is valid TypeScript for every combination of options', () => {
    for (const isPublic of [true, false]) {
      for (const url of ['https://app.acme.com', null]) {
        for (const enableEndSession of [true, false]) {
          for (const allowedScopes of [base.allowedScopes, ['openid']]) {
            const code = typescriptExample(
              {
                ...base,
                isPublic,
                url,
                enableEndSession,
                allowedScopes,
                backchannelLogoutUri: enableEndSession ? 'https://app.acme.com/bc' : null,
              },
              ISSUER,
            );
            expect(syntaxErrors(code)).toEqual([]);
          }
        }
      }
    }
  });

  it('authenticates a confidential client with its secret and a public one with none', () => {
    expect(typescriptExample(base, ISSUER)).toContain('oauth.ClientSecretBasic(process.env.CLIENT_SECRET!)');
    const pub = typescriptExample({ ...base, isPublic: true }, ISSUER);
    expect(pub).toContain('oauth.None()');
    expect(pub).not.toContain('CLIENT_SECRET');
  });

  it('validates the state and never sends a scope on refresh', () => {
    const code = typescriptExample(base, ISSUER);
    expect(code).toContain('oauth.validateAuthResponse(as, client, callbackUrl, state)');
    const refresh = code.slice(code.indexOf('export async function refresh'));
    expect(refresh).not.toMatch(/scope/);
  });

  it('only asks for a resource when the application has a url', () => {
    expect(typescriptExample(base, ISSUER)).toContain("url.searchParams.set('resource', resource)");
    const opaque = typescriptExample({ ...base, url: null }, ISSUER);
    expect(opaque).not.toContain('resource');
  });

  it('adds refresh and logout only when the application supports them', () => {
    const full = typescriptExample(base, ISSUER);
    expect(full).toContain('export async function refresh');
    expect(full).toContain('end_session_endpoint');
    expect(full).toContain("'https://app.acme.com/'");

    const minimal = typescriptExample(
      { ...base, allowedScopes: ['openid'], enableEndSession: false },
      ISSUER,
    );
    expect(minimal).not.toContain('refresh');
    expect(minimal).not.toContain('end_session_endpoint');
  });

  it('points to the back-channel guide when a logout endpoint is registered', () => {
    expect(typescriptExample(base, ISSUER)).not.toContain('Back-channel');
    const code = typescriptExample({ ...base, backchannelLogoutUri: 'https://app.acme.com/bc' }, ISSUER);
    expect(code).toContain('Back-channel logout is enabled');
  });
});

describe('pythonExample', () => {
  it('authenticates a confidential client with its secret and a public one with none', () => {
    const conf = pythonExample(base, ISSUER);
    expect(conf).toContain("os.environ['CLIENT_SECRET']");
    expect(conf).toContain("token_endpoint_auth_method='client_secret_basic'");
    const pub = pythonExample({ ...base, isPublic: true }, ISSUER);
    expect(pub).toContain("token_endpoint_auth_method='none'");
    expect(pub).not.toContain('CLIENT_SECRET');
  });

  it('validates the state and never sends a scope on refresh', () => {
    const code = pythonExample(base, ISSUER);
    expect(code).toContain('state=state');
    const refresh = code.slice(code.indexOf('def refresh'), code.indexOf('def logout_url'));
    expect(refresh).not.toContain('scope');
  });

  it('only asks for a resource when the application has a url', () => {
    expect(pythonExample(base, ISSUER)).toContain('resource=RESOURCE');
    expect(pythonExample({ ...base, url: null }, ISSUER)).not.toContain('RESOURCE');
  });

  it('adds refresh and logout only when the application supports them', () => {
    const minimal = pythonExample({ ...base, allowedScopes: ['openid'], enableEndSession: false }, ISSUER);
    expect(minimal).not.toContain('def refresh');
    expect(minimal).not.toContain('end_session_endpoint');
    expect(pythonExample(base, ISSUER)).toContain('def logout_url');
  });

  it('comments the back-channel note in Python syntax', () => {
    const code = pythonExample({ ...base, backchannelLogoutUri: 'https://app.acme.com/bc' }, ISSUER);
    expect(code).toContain('# Back-channel logout is enabled');
    expect(code.split('\n').filter((line) => line.startsWith('//'))).toEqual([]);
  });
});

describe('ioserverExample', () => {
  it('names the application and only sets the audience when it has a url', () => {
    expect(ioserverExample(base, ISSUER)).toContain('AUTH_SERVICE_APP_SLUG=acme-app');
    expect(ioserverExample(base, ISSUER)).toContain('AUTH_SERVICE_AUDIENCE=https://app.acme.com');
    expect(ioserverExample({ ...base, url: null }, ISSUER)).not.toContain('AUTH_SERVICE_AUDIENCE');
  });
});

describe('litellm examples', () => {
  const gw = { gatewayUrl: 'https://llm.example.com', authServiceUrl: ISSUER };
  const llmApp: ExampleApplication = {
    ...base,
    allowedScopes: ['openid', 'offline_access', 'wallet:self:read'],
  };
  const allResources = "'https://app.acme.com', 'https://llm.example.com', 'https://auth.example.com'";
  const gatewayOnly = "'https://llm.example.com', 'https://auth.example.com'";
  const between = (code: string, from: string, to: string): string =>
    code.slice(code.indexOf(from), code.indexOf(to));

  it('is valid TypeScript for public and confidential clients, with or without a url', () => {
    for (const isPublic of [true, false]) {
      for (const url of ['https://app.acme.com', null]) {
        const code = litellmTypescriptExample({ ...llmApp, isPublic, url }, ISSUER, gw);
        expect(syntaxErrors(code)).toEqual([]);
      }
    }
  });

  it('asks for every audience, exchanges the code without a resource and refreshes without a scope', () => {
    const code = litellmTypescriptExample(llmApp, ISSUER, gw);
    expect(code).toContain(`const resources = [${allResources}]`);
    expect(code).toContain("url.searchParams.append('resource', resource)");
    expect(between(code, 'export async function finishLogin', 'export async function tokenFor')).not.toContain(
      'additionalParameters',
    );
    expect(between(code, 'export async function tokenFor', '// 4.')).not.toMatch(/additionalParameters: \{[^}]*scope/);
  });

  it('leaves the application out of the audiences when it has no url', () => {
    const code = litellmTypescriptExample({ ...llmApp, url: null }, ISSUER, gw);
    expect(code).toContain(`const resources = [${gatewayOnly}]`);
  });

  it('reads the wallet and calls the gateway with the minted tokens', () => {
    const code = litellmTypescriptExample(llmApp, ISSUER, gw);
    expect(code).toContain('/api/user/wallet');
    expect(code).toContain('/v1`');
    expect(code).toContain('error.status === 402');
  });

  it('repeats the resource parameter in Python instead of passing a list to Authlib', () => {
    const code = litellmPythonExample(llmApp, ISSUER, gw);
    expect(code).toContain(`RESOURCES = [${allResources}]`);
    expect(code).toContain("&resource={quote(resource, safe='')}");
    expect(between(code, 'def finish_login', 'def token_for')).not.toContain('resource');
    expect(code).toContain('{WALLET_URL}/api/user/wallet');
  });

  it('authenticates a Python client by its type', () => {
    expect(litellmPythonExample(llmApp, ISSUER, gw)).toContain("os.environ['CLIENT_SECRET']");
    expect(litellmPythonExample({ ...llmApp, isPublic: true }, ISSUER, gw)).toContain(
      "token_endpoint_auth_method='none'",
    );
  });
});
