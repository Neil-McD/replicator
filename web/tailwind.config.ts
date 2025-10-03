import type { Config } from 'tailwindcss'

const config: Config = {
  darkMode: 'class',
  content: [
    './app/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    './pages/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        obsidian: '#0E0F12',
        panel: '#16181C',
        textPrimary: '#E7EAF0',
        textMuted: '#9AA4B2',
        teal: '#00C2B2',
        tealGlow: '#2EE6D6',
        success: '#47D16C',
        warning: '#F5B14C',
        danger: '#F27171',
      },
      boxShadow: {
        panel: '0 2px 8px rgba(0,0,0,0.25)',
        modal: '0 8px 24px rgba(0,0,0,0.35)',
      },
      borderRadius: {
        mdx: '12px',
        lgx: '16px',
      },
      fontFamily: {
        sans: ['var(--font-space-grotesk)'],
        mono: ['var(--font-plex-mono)'],
      },
    },
  },
  plugins: [],
}

export default config

