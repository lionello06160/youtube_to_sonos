/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        primary: "#22c55e",
        "accent-amber": "#f59e0b",
        "background-light": "#f6f6f8",
        "background-dark": "#0a0a0a",
        "card-dark": "rgba(255, 255, 255, 0.03)",
      },
      fontFamily: {
        display: ["Space Grotesk", "sans-serif"],
      },
    },
  },
  plugins: [],
}
