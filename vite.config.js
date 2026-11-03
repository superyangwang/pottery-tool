import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// GitHub Pages serves the site at https://<user>.github.io/pottery-tool/,
// so production builds need that base path. Local dev stays at '/'.
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/pottery-tool/' : '/',
  plugins: [react()],
}))
