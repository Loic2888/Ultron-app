import path from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

// jarvis gui sets the proxy target without exposing an absolute API URL to the
// browser, so requests stay on Vite's origin even on a custom frontend port.
const apiTarget = process.env.OPENJARVIS_VITE_PROXY_TARGET
  || process.env.VITE_API_URL
  || 'http://localhost:8000';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'Ultron',
        short_name: 'Ultron',
        description: 'AI-driven development workbench',
        // Opens straight on the workbench when installed as an app window.
        start_url: '/workspace',
        scope: '/',
        theme_color: '#050506',
        background_color: '#050506',
        display: 'standalone',
        // Installed app: draw into the title bar, keep only the native
        // minimize / maximize / close buttons (like VS Code).
        display_override: ['window-controls-overlay', 'standalone'],
        icons: [
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg}'],
        // The code editor (several MB) is fetched on demand, not precached.
        globIgnores: ['**/monaco-*.js', '**/*.worker-*.js', '**/EditorView-*.js'],
        navigateFallbackDenylist: [/^\/v1\//, /^\/health/, /^\/dashboard/, /^\/api\//],
      },
    }),
  ],
  build: {
    outDir: '../src/openjarvis/server/static',
    emptyOutDir: true,
    // Preserve the Vite 6 browser baseline for existing desktop webviews.
    target: ['es2020', 'edge88', 'firefox78', 'chrome87', 'safari14'],
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: 'react', test: /node_modules[\\/](react|react-dom)[\\/]/ },
            {
              name: 'markdown',
              test: /node_modules[\\/](react-markdown|rehype-highlight|remark-gfm)[\\/]/,
            },
            { name: 'charts', test: /node_modules[\\/]recharts[\\/]/ },
            { name: 'router', test: /node_modules[\\/]react-router[\\/]/ },
            // Loaded only when a file is opened; kept out of the offline cache.
            { name: 'monaco', test: /node_modules[\\/]monaco-editor[\\/]/ },
          ],
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      // ws: true is required for the /v1/agents/events WebSocket. Without it
      // Vite proxies the HTTP request but not the upgrade, so the socket never
      // opens — no error, no close event, just silence — and every live agent
      // view sits empty in dev while working in a production build.
      '/v1': {
        target: apiTarget,
        changeOrigin: true,
        ws: true,
      },
      '/health': apiTarget,
      '/api': apiTarget,
    },
  },
});
