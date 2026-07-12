import animate from 'tailwindcss-animate'

/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ['class'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        border: 'oklch(var(--border) / <alpha-value>)', input: 'oklch(var(--input) / <alpha-value>)', ring: 'oklch(var(--ring) / <alpha-value>)',
        background: 'oklch(var(--background) / <alpha-value>)', foreground: 'oklch(var(--foreground) / <alpha-value>)',
        primary: { DEFAULT: 'oklch(var(--primary) / <alpha-value>)', foreground: 'oklch(var(--primary-foreground) / <alpha-value>)' },
        secondary: { DEFAULT: 'oklch(var(--secondary) / <alpha-value>)', foreground: 'oklch(var(--secondary-foreground) / <alpha-value>)' },
        destructive: { DEFAULT: 'oklch(var(--destructive) / <alpha-value>)', foreground: 'oklch(var(--destructive-foreground) / <alpha-value>)' },
        muted: { DEFAULT: 'oklch(var(--muted) / <alpha-value>)', foreground: 'oklch(var(--muted-foreground) / <alpha-value>)' },
        accent: { DEFAULT: 'oklch(var(--accent) / <alpha-value>)', foreground: 'oklch(var(--accent-foreground) / <alpha-value>)' },
        popover: { DEFAULT: 'oklch(var(--popover) / <alpha-value>)', foreground: 'oklch(var(--popover-foreground) / <alpha-value>)' },
        card: { DEFAULT: 'oklch(var(--card) / <alpha-value>)', foreground: 'oklch(var(--card-foreground) / <alpha-value>)' },
        success: 'oklch(var(--success) / <alpha-value>)', warning: 'oklch(var(--warning) / <alpha-value>)', info: 'oklch(var(--info) / <alpha-value>)',
      },
      fontFamily: { sans: ['Manrope Variable', 'sans-serif'], display: ['Newsreader Variable', 'serif'] },
      borderRadius: { lg: 'var(--radius)', md: 'calc(var(--radius) - 2px)', sm: 'calc(var(--radius) - 4px)' },
    },
  },
  plugins: [animate],
}
