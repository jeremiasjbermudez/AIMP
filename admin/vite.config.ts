import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  // COMFY_PROXY_TARGET: ComfyUI on another machine that was not started with
  // --enable-cors-header. The browser then cannot read its responses, and the
  // app shows it offline and every render blank. Setting this serves ComfyUI
  // through the dev server at /comfy, same origin as the app; point
  // VITE_COMFY_URL at /comfy to use it.
  const comfyTarget = env.COMFY_PROXY_TARGET
  return {
    plugins: [react(), tailwindcss()],
    // 5185, so this runs alongside pipeline-admin-copy on 5184 rather than
    // fighting it for the port. strictPort means a clash fails loudly instead of
    // silently moving to another number and breaking every saved link.
    server: {
      port: 5185,
      strictPort: true,
      proxy: comfyTarget
        ? { '/comfy': { target: comfyTarget, changeOrigin: true, rewrite: (p) => p.replace(/^\/comfy/, '') } }
        : undefined,
    },
  }
})

