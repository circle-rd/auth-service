import { ref, watch } from 'vue';
import { useAppBranding } from '@/composables/useAppBranding';

// 'light' / 'dark': a transparent logo made almost entirely of light / dark
// pixels. 'color': any other transparent logo. 'neutral': nothing to adapt
// (opaque background, or impossible to analyse).
export type LogoTone = 'light' | 'dark' | 'color' | 'neutral';

const SAMPLE_SIZE = 32;
const LIGHT_THRESHOLD = 0.8;
const DARK_THRESHOLD = 0.2;
const MIN_VISIBLE_ALPHA = 0.05;
const OPAQUE_ALPHA = 0.9;

const tone = ref<LogoTone>('neutral');

function classify(data: Uint8ClampedArray): LogoTone {
  const lastRow = (SAMPLE_SIZE - 1) * SAMPLE_SIZE;
  const corners = [0, SAMPLE_SIZE - 1, lastRow, lastRow + SAMPLE_SIZE - 1];
  // A logo that paints its own opaque background is readable on any theme.
  if (corners.every((px) => data[px * 4 + 3] / 255 > OPAQUE_ALPHA)) return 'neutral';

  let weighted = 0;
  let totalAlpha = 0;
  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3] / 255;
    const luminance = (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
    weighted += luminance * alpha;
    totalAlpha += alpha;
  }
  if (totalAlpha / (SAMPLE_SIZE * SAMPLE_SIZE) < MIN_VISIBLE_ALPHA) return 'neutral';

  const mean = weighted / totalAlpha;
  if (mean > LIGHT_THRESHOLD) return 'light';
  if (mean < DARK_THRESHOLD) return 'dark';
  return 'color';
}

function detect(url: string): Promise<LogoTone> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = SAMPLE_SIZE;
      canvas.height = SAMPLE_SIZE;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return resolve('neutral');
      ctx.drawImage(img, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
      try {
        resolve(classify(ctx.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE).data));
      } catch {
        // Tainted canvas: the logo host does not send CORS headers.
        resolve('neutral');
      }
    };
    img.onerror = () => resolve('neutral');
    img.src = url;
  });
}

const { branding } = useAppBranding();

// A dedicated dark-theme logo means the operator tuned both: nothing to adapt.
watch(
  () => (branding.value.logoDarkUrl ? null : branding.value.logoUrl),
  async (url) => {
    tone.value = 'neutral';
    if (!url) return;
    const detected = await detect(url);
    if (branding.value.logoUrl === url && !branding.value.logoDarkUrl) tone.value = detected;
  },
  { immediate: true },
);

export function useLogoTone() {
  return { tone };
}
