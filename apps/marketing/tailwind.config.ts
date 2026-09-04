import type { Config } from 'tailwindcss'

const config: Config = {
  darkMode: ['class'],
  content: [
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          green: '#39B454',
          yellow: '#FFC400',
          deep: '#0B1020',
        },
        surface: {
          light: '#F8FAFC',
        },
      },
      fontFamily: {
        sans: ['var(--font-inter)', 'system-ui', 'sans-serif'],
      },
      borderRadius: {
        xl: '1rem',
        '2xl': '1.25rem',
      },
      boxShadow: {
        soft: '0 1px 2px 0 rgb(11 16 32 / 0.04), 0 4px 16px -4px rgb(11 16 32 / 0.08)',
        card: '0 1px 3px 0 rgb(11 16 32 / 0.06), 0 1px 2px -1px rgb(11 16 32 / 0.06)',
      },
      keyframes: {
        'fade-in': {
          from: { opacity: '0', transform: 'translateY(8px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        'fade-in': 'fade-in 0.5s ease-out',
      },
    },
  },
  plugins: [],
}

export default config
