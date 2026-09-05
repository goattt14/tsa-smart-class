/**
 * Single source of truth for [CLASS_NAME], [CLASS_LOGO], [PRIMARY_COLOR],
 * [SECONDARY_COLOR] and [TAGLINE]. Build-time values come from Vite env vars;
 * once a user is authenticated the institute record from the API overrides them
 * through applyBranding(), so a white-label deployment needs no code change.
 */
export interface Branding {
  name: string;
  shortName: string;
  tagline: string;
  logoUrl: string;
  primaryColor: string;
  secondaryColor: string;
  accentColor: string;
}

export const defaultBranding: Branding = {
  name: (import.meta.env.VITE_APP_NAME as string | undefined) ?? 'The Scholastic Academy',
  shortName: (import.meta.env.VITE_APP_SHORT_NAME as string | undefined) ?? 'TSA',
  tagline: (import.meta.env.VITE_APP_TAGLINE as string | undefined) ?? 'strive for success',
  logoUrl: (import.meta.env.VITE_LOGO_URL as string | undefined) ?? '/tsa-logo.png',
  primaryColor: (import.meta.env.VITE_PRIMARY_COLOR as string | undefined) ?? '#5CB82B',
  secondaryColor: (import.meta.env.VITE_SECONDARY_COLOR as string | undefined) ?? '#101418',
  accentColor: (import.meta.env.VITE_ACCENT_COLOR as string | undefined) ?? '#E8A317',
};

/** #RRGGBB -> "r g b" so Tailwind can compose alpha through color-mix. */
function toRgbTriplet(hex: string): string {
  const clean = hex.replace('#', '');
  const full =
    clean.length === 3
      ? clean
          .split('')
          .map((c) => c + c)
          .join('')
      : clean;
  const num = Number.parseInt(full, 16);
  if (Number.isNaN(num) || full.length !== 6) return '92 184 43';
  return `${(num >> 16) & 255} ${(num >> 8) & 255} ${num & 255}`;
}

function mix(hex: string, withColor: string, weight: number): string {
  return `color-mix(in srgb, ${hex} ${Math.round(weight * 100)}%, ${withColor})`;
}

/** Writes branding into CSS custom properties consumed by Tailwind. */
export function applyBranding(branding: Branding = defaultBranding): void {
  const root = document.documentElement;
  root.style.setProperty('--brand', branding.primaryColor);
  root.style.setProperty('--brand-rgb', toRgbTriplet(branding.primaryColor));
  root.style.setProperty('--brand-deep', mix(branding.primaryColor, '#000000', 0.78));
  root.style.setProperty('--brand-soft', mix(branding.primaryColor, '#ffffff', 0.18));
  root.style.setProperty('--brand-tint', mix(branding.primaryColor, '#ffffff', 0.1));
  root.style.setProperty('--ink', branding.secondaryColor);
  root.style.setProperty('--ink-soft', mix(branding.secondaryColor, '#ffffff', 0.72));
  root.style.setProperty('--ink-muted', mix(branding.secondaryColor, '#ffffff', 0.48));
  root.style.setProperty('--accent', branding.accentColor);

  const themeMeta = document.querySelector('meta[name="theme-color"]');
  if (themeMeta) themeMeta.setAttribute('content', branding.primaryColor);
  document.title = branding.name;
}
