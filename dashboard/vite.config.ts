import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// La API exige `X-Telemetry-Key` en toda la superficie salvo el health check. El
// proxy la inyecta para que la clave nunca llegue al navegador: el dashboard sigue
// hablando sólo con su propio origen.
function resolveTelemetryKey(): string | undefined {
  const fromEnvironment = process.env.TELEMETRY_API_KEY ?? process.env.OPENCODE_OBSERVABILITY_KEY;
  if (fromEnvironment) return fromEnvironment;
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) return undefined;
  try {
    return readFileSync(join(localAppData, 'AgentObservabilityPlatform', 'telemetry.key'), 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}

const key = resolveTelemetryKey();
const authHeaders: Record<string, string> = key ? { 'X-Telemetry-Key': key } : {};

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': { target: 'http://127.0.0.1:5080', headers: authHeaders },
      '/hubs': {
        target: 'http://127.0.0.1:5080',
        ws: true,
        headers: authHeaders,
        configure: (proxy) => {
          const apply = (request: { setHeader: (name: string, value: string) => void }) => {
            for (const [name, value] of Object.entries(authHeaders)) request.setHeader(name, value);
          };
          proxy.on('proxyReq', apply);
          proxy.on('proxyReqWs', apply);
        },
      },
    },
  },
});
