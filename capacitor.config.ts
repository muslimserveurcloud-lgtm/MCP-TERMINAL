import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.muslim.mcpterminal',
  appName: 'MUSLIM MCP TERMINAL',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
    // Autorise aussi les serveurs MCP en http:// sur votre réseau local (l'app avertit à l'ajout).
    cleartext: true,
  },
  plugins: {
    // Les requêtes passent par la pile HTTP native d'Android : pas de blocage CORS côté serveurs MCP.
    CapacitorHttp: { enabled: true },
  },
};

export default config;
