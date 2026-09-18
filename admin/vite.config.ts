import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // 5185, so this runs alongside pipeline-admin-copy on 5184 rather than
  // fighting it for the port. strictPort means a clash fails loudly instead of
  // silently moving to another number and breaking every saved link.
  server: { port: 5185, strictPort: true },
})

