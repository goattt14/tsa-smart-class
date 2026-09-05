import type { Config } from 'tailwindcss';

/**
 * Colours resolve through CSS variables so a single branding record in the
 * database can restyle the whole product without a rebuild.
 */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          DEFAULT: 'var(--brand)',
          soft: 'var(--brand-soft)',
          deep: 'var(--brand-deep)',
          tint: 'var(--brand-tint)',
        },
        ink: {
          DEFAULT: 'var(--ink)',
          soft: 'var(--ink-soft)',
          muted: 'var(--ink-muted)',
        },
        surface: {
          DEFAULT: 'var(--surface)',
          raised: 'var(--surface-raised)',
          sunken: 'var(--surface-sunken)',
        },
        line: 'var(--line)',
        accent: 'var(--accent)',
        positive: 'var(--positive)',
        caution: 'var(--caution)',
        critical: 'var(--critical)',
      },
      fontFamily: {
        display: ['Inter', 'system-ui', 'sans-serif'],
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '1rem', letterSpacing: '0.04em' }],
      },
      borderRadius: {
        card: '14px',
        pill: '999px',
      },
      boxShadow: {
        card: '0 1px 2px rgba(16, 20, 24, 0.04), 0 8px 24px -12px rgba(16, 20, 24, 0.16)',
        lift: '0 2px 4px rgba(16, 20, 24, 0.06), 0 16px 40px -16px rgba(16, 20, 24, 0.24)',
      },
      transitionTimingFunction: {
        'out-quint': 'cubic-bezier(0.22, 1, 0.36, 1)',
      },
      keyframes: {
        'fade-up': {
          from: { opacity: '0', transform: 'translateY(6px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'pulse-ring': {
          '0%': { transform: 'scale(0.95)', opacity: '0.7' },
          '70%': { transform: 'scale(1.25)', opacity: '0' },
          '100%': { transform: 'scale(1.25)', opacity: '0' },
        },
      },
      animation: {
        'fade-up': 'fade-up 320ms cubic-bezier(0.22, 1, 0.36, 1) both',
        'pulse-ring': 'pulse-ring 1800ms cubic-bezier(0.22, 1, 0.36, 1) infinite',
      },
    },
  },
  plugins: [],
} satisfies Config;
