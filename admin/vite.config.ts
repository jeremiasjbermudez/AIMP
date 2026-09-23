import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  // Services reached through this dev server, same origin as the app, when
  // their *_PROXY_TARGET is set:
  //   /comfy     COMFY_PROXY_TARGET    a ComfyUI started without
  //              --enable-cors-header, whose responses the browser could not
  //              read: the app showed it offline and every render blank.
  //   /api       INSFORGE_PROXY_TARGET the database API (the SDK's own paths,
  //              so VITE_INSFORGE_URL is "/"), and
  //   /flowise   FLOWISE_PROXY_TARGET  the flows, when both run on the same
  //              machine as this server and listen on loopback only. Then this
  //              port is the one thing another machine has to reach.
  // Point VITE_COMFY_URL at /comfy, VITE_FLOWISE_URL at /flowise and
  // VITE_INSFORGE_URL at /.
  const proxy: Record<string, object> = {}
  const route = (prefix: string, target: string | undefined, ws = false) => {
    if (!target) return
    proxy[prefix] = { target, changeOrigin: true, ws, rewrite: (p: string) => p.replace(new RegExp('^' + prefix), '') }
  }
  route('/comfy', env.COMFY_PROXY_TARGET)
  if (env.INSFORGE_PROXY_TARGET) proxy['/api'] = { target: env.INSFORGE_PROXY_TARGET, changeOrigin: true, ws: true }
  route('/flowise', env.FLOWISE_PROXY_TARGET)
  return {
    plugins: [react(), tailwindcss()],
    // 5185, so this runs alongside pipeline-admin-copy on 5184 rather than
    // fighting it for the port. strictPort means a clash fails loudly instead of
    // silently moving to another number and breaking every saved link.
    // ADMIN_HOST: the address to listen on - loopback unless another machine
    // is meant to open the app (the render host's Tailscale address, say).
    server: {
      host: env.ADMIN_HOST || undefined,
      port: 5185,
      strictPort: true,
      proxy: Object.keys(proxy).length ? proxy : undefined,
    },
  }
})
