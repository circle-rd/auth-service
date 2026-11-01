// Integration examples shown on the application page. Kept free of Vue and of
// the app's own types so the generated code can be rendered and executed by a
// test against a real instance.

export interface ExampleApplication {
  slug: string;
  url: string | null;
  redirectUris: string[];
  allowedScopes: string[];
  isPublic: boolean;
  enableEndSession: boolean;
  postLogoutRedirectUris: string[];
  backchannelLogoutUri: string | null;
}

interface ExampleValues {
  issuer: string;
  slug: string;
  redirectUri: string;
  scope: string;
  // Absent when the application has no `url`: its access tokens are then opaque.
  resource: string | null;
  isPublic: boolean;
  offline: boolean;
  endSession: boolean;
  postLogoutUri: string;
  backchannel: boolean;
}

function valuesOf(app: ExampleApplication, issuer: string): ExampleValues {
  return {
    issuer,
    slug: app.slug,
    redirectUri: app.redirectUris[0] ?? 'https://your-app.com/callback',
    scope: app.allowedScopes.join(' '),
    resource: app.url,
    isPublic: app.isPublic,
    offline: app.allowedScopes.includes('offline_access'),
    endSession: app.enableEndSession,
    postLogoutUri: app.postLogoutRedirectUris[0] ?? 'https://your-app.com/',
    backchannel: app.backchannelLogoutUri !== null,
  };
}

const BACKCHANNEL_NOTE =
  "Back-channel logout is enabled: your server is also called when a session ends elsewhere.\n// See the integration guide, section \"Back-channel logout\", for the endpoint to implement.";

function tsSetup(v: ExampleValues, resourceLine: string, extraImports = ''): string {
  const clientAuth = v.isPublic
    ? `const clientAuth = oauth.None(); // public client: PKCE only, no secret`
    : `const clientAuth = oauth.ClientSecretBasic(process.env.CLIENT_SECRET!); // keep the secret server-side`;
  return `import * as oauth from 'oauth4webapi';${extraImports}

const issuer = new URL('${v.issuer}');
const redirectUri = '${v.redirectUri}';
const scope = '${v.scope}';
${resourceLine}
const client: oauth.Client = { client_id: '${v.slug}' };
${clientAuth}
const as = await oauth
  .discoveryRequest(issuer)
  .then((response) => oauth.processDiscoveryResponse(issuer, response));
`;
}

export function typescriptExample(app: ExampleApplication, issuer: string): string {
  const v = valuesOf(app, issuer);
  const resourceLine = v.resource
    ? `const resource = '${v.resource}'; // RFC 8707: the API these tokens are issued for\n`
    : '';
  const resourceParam = v.resource ? `\n  url.searchParams.set('resource', resource);` : '';
  const resourceExtra = v.resource ? `\n    { additionalParameters: { resource } },` : '';
  const refresh = v.offline
    ? `
// 3. Renew the access token. Do not send \`scope\`: the refresh token would lose
//    the scopes it was issued with.
export async function refresh(refreshToken: string) {
  const response = await oauth.refreshTokenGrantRequest(
    as, client, clientAuth, refreshToken,${v.resource ? '\n    { additionalParameters: { resource } },' : ''}
  );
  return oauth.processRefreshTokenResponse(as, client, response);
}
`
    : '';

  const logout = v.endSession
    ? `
// ${v.offline ? '4' : '3'}. Sign the user out of every application. Send the browser to this URL
//    with the ID token received at sign-in.
export function logoutUrl(idToken: string) {
  const url = new URL(as.end_session_endpoint!);
  url.searchParams.set('id_token_hint', idToken);
  url.searchParams.set('post_logout_redirect_uri', '${v.postLogoutUri}');
  return url;
}
`
    : '';

  const note = v.backchannel ? `\n// ${BACKCHANNEL_NOTE}\n` : '';

  return `${tsSetup(v, resourceLine)}
// 1. Send the user to sign in. Keep \`codeVerifier\` and \`state\` in their session.
export async function startLogin() {
  const codeVerifier = oauth.generateRandomCodeVerifier();
  const state = oauth.generateRandomState();
  const url = new URL(as.authorization_endpoint!);
  url.searchParams.set('client_id', client.client_id);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', scope);${resourceParam}
  url.searchParams.set('code_challenge', await oauth.calculatePKCECodeChallenge(codeVerifier));
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  return { url, codeVerifier, state };
}

// 2. In the handler of your redirect URI, with the full callback URL.
export async function finishLogin(callbackUrl: URL, codeVerifier: string, state: string) {
  const params = oauth.validateAuthResponse(as, client, callbackUrl, state);
  const response = await oauth.authorizationCodeGrantRequest(
    as, client, clientAuth, params, redirectUri, codeVerifier,${resourceExtra}
  );
  const tokens = await oauth.processAuthorizationCodeResponse(as, client, response);
  const claims = oauth.getValidatedIdTokenClaims(tokens)!; // sub, sid, email, roles...
  return { tokens, claims };
}
${refresh}${logout}${note}`;
}

export function pythonExample(app: ExampleApplication, issuer: string): string {
  const v = valuesOf(app, issuer);
  const resourceConst = v.resource
    ? `RESOURCE = '${v.resource}'  # RFC 8707: the API these tokens are issued for\n`
    : '';
  const resourceKw = v.resource ? ', resource=RESOURCE' : '';
  const session = v.isPublic
    ? `    return OAuth2Session(
        CLIENT_ID,
        scope=SCOPE,
        redirect_uri=REDIRECT_URI,
        code_challenge_method='S256',
        token_endpoint_auth_method='none',  # public client: PKCE only, no secret
    )`
    : `    return OAuth2Session(
        CLIENT_ID,
        os.environ['CLIENT_SECRET'],  # keep the secret server-side
        scope=SCOPE,
        redirect_uri=REDIRECT_URI,
        code_challenge_method='S256',
        token_endpoint_auth_method='client_secret_basic',
    )`;

  const refresh = v.offline
    ? `

# 3. Renew the access token. Do not send \`scope\`: the refresh token would lose
#    the scopes it was issued with.
def refresh(token):
    return session().refresh_token(
        metadata['token_endpoint'],
        refresh_token=token['refresh_token']${resourceKw},
    )`
    : '';

  const logout = v.endSession
    ? `

# ${v.offline ? '4' : '3'}. Sign the user out of every application. Send the browser to this URL
#    with the ID token received at sign-in (token['id_token']).
def logout_url(id_token):
    query = urlencode({
        'id_token_hint': id_token,
        'post_logout_redirect_uri': '${v.postLogoutUri}',
    })
    return f"{metadata['end_session_endpoint']}?{query}"`
    : '';

  const note = v.backchannel
    ? `\n\n# ${BACKCHANNEL_NOTE.replace(/\n\/\/ /g, '\n# ')}`
    : '';

  return `import os
import secrets
from urllib.parse import urlencode

import requests
from authlib.integrations.requests_client import OAuth2Session

ISSUER = '${v.issuer}'
CLIENT_ID = '${v.slug}'
REDIRECT_URI = '${v.redirectUri}'
SCOPE = '${v.scope}'
${resourceConst}
metadata = requests.get(f'{ISSUER}/.well-known/openid-configuration', timeout=10).json()


def session():
${session}


# 1. Send the user to sign in. Keep \`state\` and \`verifier\` in their session.
def start_login():
    verifier = secrets.token_urlsafe(64)
    url, state = session().create_authorization_url(
        metadata['authorization_endpoint'], code_verifier=verifier${resourceKw},
    )
    return url, state, verifier


# 2. In the handler of your redirect URI, with the full callback URL.
def finish_login(callback_url, state, verifier):
    return session().fetch_token(
        metadata['token_endpoint'],
        authorization_response=callback_url,
        state=state,
        code_verifier=verifier${resourceKw},
    )${refresh}${logout}${note}
`;
}

export function ioserverExample(app: ExampleApplication, issuer: string): string {
  const v = valuesOf(app, issuer);
  const audience = v.resource
    ? `AUTH_SERVICE_AUDIENCE=${v.resource}  # JWT aud claim = resource URL\n`
    : '';
  return `# .env
AUTH_SERVICE_URL=${v.issuer}
AUTH_SERVICE_APP_SLUG=${v.slug}
${audience}
# --- src/index.ts ---
import {
  OidcConfigManager,
  OidcHttpMiddleware,
  OidcSocketMiddleware,
} from 'ioserver-oidc';

// Register the OIDC config manager (reads the env vars above)
server.addManager({ name: 'oidcConfig', manager: OidcConfigManager });

// Protect HTTP routes
server.addController({
  name: 'api',
  controller: ApiController,
  middlewares: [OidcHttpMiddleware],
  prefix: '/api',
});

// Protect Socket.IO namespaces
server.addService({
  name: 'events',
  service: EventService,
  middlewares: [OidcSocketMiddleware],
});

// Inside a controller/service handler (cast the request or socket to any):
// request.sub         → OIDC subject (stable user ID)
// request.roles       → string[]  (needs the 'roles' scope)
// request.permissions → string[]  (needs the 'permissions' scope)
// request.features    → object    (needs the 'features' scope)`;
}

export interface LitellmEndpoints {
  gatewayUrl: string;
  authServiceUrl: string;
}

// The audiences a LiteLLM-enabled application signs in for, in the order of the
// guide: its own API (when it has a url), the gateway, and the wallet API.
function litellmResources(app: ExampleApplication, gw: LitellmEndpoints): string[] {
  return [app.url, gw.gatewayUrl, gw.authServiceUrl].filter((r): r is string => r !== null);
}

export function litellmTypescriptExample(
  app: ExampleApplication,
  issuer: string,
  gw: LitellmEndpoints,
): string {
  const v = valuesOf(app, issuer);
  const resources = litellmResources(app, gw)
    .map((r) => `'${r}'`)
    .join(', ');
  const resourceLines = `const resources = [${resources}]; // RFC 8707: one token can serve all of them
const gatewayUrl = '${gw.gatewayUrl}';
const walletUrl = '${gw.authServiceUrl}';
`;
  return `${tsSetup(v, resourceLines, "\nimport OpenAI from 'openai';")}
// 1. Send the user to sign in, for every audience at once.
export async function startLogin() {
  const codeVerifier = oauth.generateRandomCodeVerifier();
  const state = oauth.generateRandomState();
  const url = new URL(as.authorization_endpoint!);
  url.searchParams.set('client_id', client.client_id);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', scope);
  for (const resource of resources) url.searchParams.append('resource', resource);
  url.searchParams.set('code_challenge', await oauth.calculatePKCECodeChallenge(codeVerifier));
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  return { url, codeVerifier, state };
}

// 2. In the handler of your redirect URI. Send no \`resource\` here: the token is
//    then issued for the whole set above. Store \`refresh_token\` server-side.
export async function finishLogin(callbackUrl: URL, codeVerifier: string, state: string) {
  const params = oauth.validateAuthResponse(as, client, callbackUrl, state);
  const response = await oauth.authorizationCodeGrantRequest(
    as, client, clientAuth, params, redirectUri, codeVerifier,
  );
  return oauth.processAuthorizationCodeResponse(as, client, response);
}

// 3. Mint a short-lived token for ONE audience. The refresh token rotates: keep
//    the new one. Never send \`scope\`: it would strip the scopes of the grant.
export async function tokenFor(refreshToken: string, resource: string) {
  const response = await oauth.refreshTokenGrantRequest(
    as, client, clientAuth, refreshToken,
    { additionalParameters: { resource } },
  );
  const result = await oauth.processRefreshTokenResponse(as, client, response);
  return { accessToken: result.access_token, refreshToken: result.refresh_token! };
}

// 4. Check the wallet before an expensive job (token minted for \`walletUrl\`).
export async function canSpend(walletToken: string) {
  const response = await fetch(\`\${walletUrl}/api/user/wallet\`, {
    headers: { authorization: \`Bearer \${walletToken}\` },
  });
  if (!response.ok) throw new Error(\`wallet: HTTP \${response.status}\`);
  const wallet = (await response.json()) as { balance: string; canSpend: boolean };
  return wallet.canSpend;
}

// 5. Call the gateway: it is OpenAI-compatible and the access token is the API key.
//    \`sessionId\` is optional: it lets you read what one chat session cost.
export async function chat(gatewayToken: string, content: string, sessionId?: string) {
  const openai = new OpenAI({ baseURL: \`\${gatewayUrl}/v1\`, apiKey: gatewayToken });
  try {
    return await openai.chat.completions.create({
      model: 'gpt-4o-mini', // a model granted to the user's plan
      messages: [{ role: 'user', content }],
      ...(sessionId ? { metadata: { session_id: sessionId } } : {}),
    });
  } catch (error) {
    if (error instanceof OpenAI.APIError && error.status === 402) {
      // Out of credit: send the user to \${walletUrl}/profile to top up.
    }
    throw error;
  }
}
`;
}

export function litellmPythonExample(
  app: ExampleApplication,
  issuer: string,
  gw: LitellmEndpoints,
): string {
  const v = valuesOf(app, issuer);
  const resources = litellmResources(app, gw)
    .map((r) => `'${r}'`)
    .join(', ');
  const session = v.isPublic
    ? `    return OAuth2Session(
        CLIENT_ID,
        scope=SCOPE,
        redirect_uri=REDIRECT_URI,
        code_challenge_method='S256',
        token_endpoint_auth_method='none',  # public client: PKCE only, no secret
    )`
    : `    return OAuth2Session(
        CLIENT_ID,
        os.environ['CLIENT_SECRET'],  # keep the secret server-side
        scope=SCOPE,
        redirect_uri=REDIRECT_URI,
        code_challenge_method='S256',
        token_endpoint_auth_method='client_secret_basic',
    )`;
  return `import os
import secrets
from urllib.parse import quote

import requests
from authlib.integrations.requests_client import OAuth2Session
from openai import OpenAI, APIStatusError

ISSUER = '${v.issuer}'
CLIENT_ID = '${v.slug}'
REDIRECT_URI = '${v.redirectUri}'
SCOPE = '${v.scope}'
RESOURCES = [${resources}]  # RFC 8707: one token can serve all of them
GATEWAY_URL = '${gw.gatewayUrl}'
WALLET_URL = '${gw.authServiceUrl}'

metadata = requests.get(f'{ISSUER}/.well-known/openid-configuration', timeout=10).json()


def session():
${session}


# 1. Send the user to sign in, for every audience at once. \`resource\` repeats once
#    per audience: Authlib would turn a list into a single value, so append them.
def start_login():
    verifier = secrets.token_urlsafe(64)
    url, state = session().create_authorization_url(
        metadata['authorization_endpoint'], code_verifier=verifier,
    )
    url += ''.join(f"&resource={quote(resource, safe='')}" for resource in RESOURCES)
    return url, state, verifier


# 2. In the handler of your redirect URI. Send no \`resource\` here: the token is
#    then issued for the whole set above. Store the refresh token server-side.
def finish_login(callback_url, state, verifier):
    return session().fetch_token(
        metadata['token_endpoint'],
        authorization_response=callback_url,
        state=state,
        code_verifier=verifier,
    )


# 3. Mint a short-lived token for ONE audience. The refresh token rotates: keep
#    the new one. Never send \`scope\`: it would strip the scopes of the grant.
def token_for(refresh_token, resource):
    return session().refresh_token(
        metadata['token_endpoint'], refresh_token=refresh_token, resource=resource,
    )


# 4. Check the wallet before an expensive job (token minted for WALLET_URL).
def can_spend(wallet_token):
    response = requests.get(
        f'{WALLET_URL}/api/user/wallet',
        headers={'Authorization': f'Bearer {wallet_token}'},
        timeout=10,
    )
    response.raise_for_status()
    return response.json()['canSpend']


# 5. Call the gateway: it is OpenAI-compatible and the access token is the API key.
#    \`session_id\` is optional: it lets you read what one chat session cost.
def chat(gateway_token, content, session_id=None):
    client = OpenAI(base_url=f'{GATEWAY_URL}/v1', api_key=gateway_token)
    try:
        return client.chat.completions.create(
            model='gpt-4o-mini',  # a model granted to the user's plan
            messages=[{'role': 'user', 'content': content}],
            **({'metadata': {'session_id': session_id}} if session_id else {}),
        )
    except APIStatusError as error:
        if error.status_code == 402:
            ...  # out of credit: send the user to f'{WALLET_URL}/profile' to top up
        raise
`;
}
