<script setup lang="ts">
    import { ref, onMounted, computed } from "vue";
    import { useRoute, RouterLink } from "vue-router";
    import { useI18n } from "vue-i18n";
    import { ArrowLeft, Copy, Check, Code2 } from "lucide-vue-next";

    const { t } = useI18n();
    const route = useRoute();
    const appId = computed(() => route.params.id as string);

    type Framework = "vue" | "react" | "node";
    const activeTab = ref<Framework>("vue");

    interface AppInfo {
        slug: string;
        redirectUris: string[];
    }
    const appInfo = ref<AppInfo | null>(null);

    onMounted(async () => {
        try {
            const res = await fetch(`/api/admin/applications/${appId.value}`, {
                credentials: "include",
            });
            if (res.ok) {
                const data = (await res.json()) as { application: AppInfo; };
                appInfo.value = data.application;
            }
        } catch {
            /* silent – snippets are still useful without dynamic values */
        }
    });

    const clientId = computed(() => appInfo.value?.slug ?? "YOUR_CLIENT_ID");
    const redirectUri = computed(
        () => appInfo.value?.redirectUris[0] ?? "https://your-app.example.com/callback",
    );
    const authServiceUrl = computed(() => window.location.origin);

    // ── Copy helper ─────────────────────────────────────────────────────────────
    const copiedKey = ref<string | null>(null);
    async function copyCode(key: string, text: string) {
        await navigator.clipboard.writeText(text);
        copiedKey.value = key;
        setTimeout(() => (copiedKey.value = null), 1800);
    }

    // ── Code snippets ────────────────────────────────────────────────────────────
    const vueSnippet = computed(() => `// Install: pnpm add oidc-client-ts
import { UserManager, WebStorageStateStore } from "oidc-client-ts";

const userManager = new UserManager({
  authority: "${authServiceUrl.value}",
  client_id: "${clientId.value}",
  redirect_uri: "${redirectUri.value}",
  response_type: "code",
  scope: "openid profile email",
  userStore: new WebStorageStateStore({ store: window.localStorage }),
});

// Trigger login
export function login() {
  return userManager.signinRedirect();
}

// Handle callback (in your /callback route component)
export async function handleCallback() {
  const user = await userManager.signinRedirectCallback();
  console.log("Logged in:", user.profile);
  return user;
}

// Get current user
export function getUser() {
  return userManager.getUser();
}

// Logout
export function logout() {
  return userManager.signoutRedirect();
}
`);

    const reactSnippet = computed(() => `// Install: npm install oidc-client-ts react-oidc-context
import { AuthProvider, useAuth } from "react-oidc-context";

const oidcConfig = {
  authority: "${authServiceUrl.value}",
  client_id: "${clientId.value}",
  redirect_uri: "${redirectUri.value}",
  scope: "openid profile email",
};

// Wrap your app
function App() {
  return (
    <AuthProvider {...oidcConfig}>
      <MyApp />
    </AuthProvider>
  );
}

// In any component
function MyApp() {
  const auth = useAuth();

  if (auth.isLoading) return <div>Loading...</div>;
  if (auth.error) return <div>Error: {auth.error.message}</div>;

  if (auth.isAuthenticated) {
    return (
      <div>
        <p>Hello, {auth.user?.profile.name}</p>
        <button onClick={() => auth.removeUser()}>Sign out</button>
      </div>
    );
  }

  return <button onClick={() => auth.signinRedirect()}>Sign in</button>;
}
`);

    const nodeSnippet = computed(() => `// Install: npm install openid-client
import { Issuer } from "openid-client";
import express from "express";
import session from "express-session";

const app = express();
app.use(session({ secret: process.env.SESSION_SECRET!, resave: false, saveUninitialized: false }));

let client: ReturnType<Awaited<ReturnType<typeof Issuer.discover>>["Client"]["new"]>;

async function initOidc() {
  const issuer = await Issuer.discover("${authServiceUrl.value}");
  client = new issuer.Client({
    client_id: "${clientId.value}",
    client_secret: process.env.CLIENT_SECRET!,
    redirect_uris: ["${redirectUri.value}"],
    response_types: ["code"],
  });
}

// Redirect to login
app.get("/login", (_req, res) => {
  const url = client.authorizationUrl({
    scope: "openid profile email",
    redirect_uri: "${redirectUri.value}",
  });
  res.redirect(url);
});

// Handle OAuth callback
app.get("/callback", async (req, res) => {
  const params = client.callbackParams(req);
  const tokenSet = await client.oauthCallback("${redirectUri.value}", params);
  const userInfo = await client.userinfo(tokenSet.access_token!);
  (req.session as { user?: unknown }).user = userInfo;
  res.redirect("/dashboard");
});

initOidc().then(() => app.listen(3000));
`);
</script>

<template>
    <div class="space-y-6">
        <!-- Header -->
        <div class="flex items-center gap-3">
            <RouterLink :to="`/admin/applications/${appId}`" class="btn btn-ghost p-2 shrink-0"
                :title="t('common.back')">
                <ArrowLeft class="w-4 h-4" />
            </RouterLink>
            <div>
                <h1 class="text-xl font-bold gradient-text">{{ t("admin.integration") }}</h1>
                <p class="text-sm mt-0.5" style="color: var(--color-text-muted)">
                    Exemples de code OAuth 2.0 / OIDC pour intégrer cette application.
                </p>
            </div>
        </div>

        <!-- Config reference card -->
        <div class="card">
            <h2 class="text-sm font-semibold mb-3">Informations de connexion</h2>
            <div class="grid gap-4 sm:grid-cols-2">
                <div>
                    <p class="text-xs font-medium mb-1" style="color: var(--color-text-muted)">Client ID (slug)</p>
                    <code class="text-sm font-mono" style="color: var(--color-primary)">{{ clientId }}</code>
                </div>
                <div>
                    <p class="text-xs font-medium mb-1" style="color: var(--color-text-muted)">Issuer / Authority</p>
                    <code class="text-sm font-mono" style="color: var(--color-primary)">{{ authServiceUrl }}</code>
                </div>
                <div>
                    <p class="text-xs font-medium mb-1" style="color: var(--color-text-muted)">Redirect URI (première)</p>
                    <code class="text-sm font-mono break-all" style="color: var(--color-primary)">{{ redirectUri }}</code>
                </div>
                <div>
                    <p class="text-xs font-medium mb-1" style="color: var(--color-text-muted)">Discovery document</p>
                    <code class="text-sm font-mono break-all" style="color: var(--color-primary)">
            {{ authServiceUrl }}/.well-known/openid-configuration
          </code>
                </div>
            </div>
        </div>

        <!-- Framework tabs -->
        <div class="card !p-0 overflow-hidden">
            <!-- Tab bar -->
            <div class="flex border-b" style="border-color: var(--color-border)">
                <button v-for="(label, key) in { vue: 'Vue 3', react: 'React', node: 'Node.js (TypeScript)' }"
                    :key="key" class="flex items-center gap-2 px-5 py-3 text-sm font-medium transition-colors relative"
                    :style="activeTab === key
                        ? 'color: var(--color-primary)'
                        : 'color: var(--color-text-muted)'" @click="activeTab = key as Framework">
                    <Code2 class="w-3.5 h-3.5" />
                    {{ label }}
                    <span v-if="activeTab === key" class="absolute bottom-0 left-0 right-0 h-0.5"
                        style="background: var(--color-primary)" />
                </button>
            </div>

            <!-- Code block: Vue -->
            <div v-if="activeTab === 'vue'" class="relative">
                <button class="absolute top-3 right-3 btn btn-ghost p-2 z-10"
                    :title="copiedKey === 'vue' ? 'Copied!' : 'Copy'" @click="copyCode('vue', vueSnippet)">
                    <Check v-if="copiedKey === 'vue'" class="w-4 h-4" style="color: var(--color-success)" />
                    <Copy v-else class="w-4 h-4" />
                </button>
                <pre class="overflow-x-auto p-5 text-xs leading-relaxed font-mono"
                    style="background: var(--color-bg); color: var(--color-text)"><code>{{ vueSnippet }}</code></pre>
            </div>

            <!-- Code block: React -->
            <div v-if="activeTab === 'react'" class="relative">
                <button class="absolute top-3 right-3 btn btn-ghost p-2 z-10"
                    :title="copiedKey === 'react' ? 'Copied!' : 'Copy'" @click="copyCode('react', reactSnippet)">
                    <Check v-if="copiedKey === 'react'" class="w-4 h-4" style="color: var(--color-success)" />
                    <Copy v-else class="w-4 h-4" />
                </button>
                <pre class="overflow-x-auto p-5 text-xs leading-relaxed font-mono"
                    style="background: var(--color-bg); color: var(--color-text)"><code>{{ reactSnippet }}</code></pre>
            </div>

            <!-- Code block: Node.js -->
            <div v-if="activeTab === 'node'" class="relative">
                <button class="absolute top-3 right-3 btn btn-ghost p-2 z-10"
                    :title="copiedKey === 'node' ? 'Copied!' : 'Copy'" @click="copyCode('node', nodeSnippet)">
                    <Check v-if="copiedKey === 'node'" class="w-4 h-4" style="color: var(--color-success)" />
                    <Copy v-else class="w-4 h-4" />
                </button>
                <pre class="overflow-x-auto p-5 text-xs leading-relaxed font-mono"
                    style="background: var(--color-bg); color: var(--color-text)"><code>{{ nodeSnippet }}</code></pre>
            </div>
        </div>

        <!-- Note -->
        <p class="text-xs" style="color: var(--color-text-muted)">
            Le <code class="font-mono">client_secret</code> doit être conservé côté serveur uniquement.
            Retrieve it from the application's <strong>Settings → Secret</strong> menu.
        </p>
    </div>
</template>
