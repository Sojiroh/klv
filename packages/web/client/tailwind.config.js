/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        display: ['Syne', 'sans-serif'],
        body: ['Outfit', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
      // Paleta clara estilo Datadog: fondo gris lavanda, superficies blancas y morado como acento
      colors: {
        klv: {
          base: '#f4f4f8',
          surface: '#ffffff',
          elevated: '#f8f8fb',
          border: '#dcdbe6',
          'border-subtle': '#ecebf2',
          accent: '#632ca6',
          'accent-hover': '#7a3fc4',
          nav: '#2b2342',
          'nav-hover': '#3b3159',
          text: '#1f1d2e',
          'text-secondary': '#5f5c74',
          'text-muted': '#8c899f',
        },
      },
      animation: {
        'fade-in': 'fadeIn 0.4s ease-out',
        'slide-up': 'slideUp 0.4s ease-out',
        'slide-in-right': 'slideInRight 0.3s ease-out',
        'pulse-dot': 'pulseDot 2s ease-in-out infinite',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideUp: {
          '0%': { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        slideInRight: {
          '0%': { transform: 'translateX(100%)' },
          '100%': { transform: 'translateX(0)' },
        },
        pulseDot: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.4' },
        },
      },
    },
  },
  plugins: [],
};
