import { ref } from 'vue';

interface BrandingState {
  appName: string;
  logoUrl: string | null;
  logoDarkUrl: string | null;
  loaded: boolean;
}

const state = ref<BrandingState>({
  appName: 'CIRCLE Auth',
  logoUrl: null,
  logoDarkUrl: null,
  loaded: false,
});

// Whether the deployment can send verification emails (SMTP configured) AND
// enforces email verification. Drives the visibility of the admin actions.
const emailVerificationEnabled = ref(false);

// Whether the deployment serves the public landing page at `/`.
const showcase = ref(false);

let inflight: Promise<void> | null = null;

async function load(): Promise<void> {
  if (state.value.loaded) return;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const res = await fetch('/api/app-config');
      if (!res.ok) return;
      const data = (await res.json()) as {
        appName?: string;
        logoUrl?: string | null;
        logoDarkUrl?: string | null;
        emailVerificationEnabled?: boolean;
        showcase?: boolean;
      };
      if (data.appName) state.value.appName = data.appName;
      if (data.logoUrl) state.value.logoUrl = data.logoUrl;
      if (data.logoDarkUrl) state.value.logoDarkUrl = data.logoDarkUrl;
      emailVerificationEnabled.value = data.emailVerificationEnabled === true;
      showcase.value = data.showcase === true;
      state.value.loaded = true;
      applyFavicon(state.value.logoUrl);
      if (typeof document !== 'undefined') document.title = state.value.appName;
    } catch {
      // Silent: keep defaults.
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

function applyFavicon(url: string | null): void {
  if (!url || typeof document === 'undefined') return;
  // Remove every existing icon link (the bundled SVG default carries a fixed
  // type attribute that would otherwise prevent the browser from loading
  // PNG/JPG/ICO logos provided via APP_LOGO_URL).
  document
    .querySelectorAll<HTMLLinkElement>('link[rel~="icon"]')
    .forEach((el) => el.remove());
  const link = document.createElement('link');
  link.rel = 'icon';
  link.href = url;
  const ext = url.split('?')[0].split('.').pop()?.toLowerCase();
  const mimeByExt: Record<string, string> = {
    svg: 'image/svg+xml',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    ico: 'image/x-icon',
    webp: 'image/webp',
  };
  if (ext && mimeByExt[ext]) link.type = mimeByExt[ext];
  document.head.appendChild(link);
}

export function useAppBranding() {
  return { branding: state, emailVerificationEnabled, showcase, load };
}
