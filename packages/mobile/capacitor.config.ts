import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'io.github.itsdommie.grimoire',
  appName: 'Grimoire',
  webDir: 'dist',
  backgroundColor: '#12131a', // the app is dark: no white flash or white status bar behind it
  android: { allowMixedContent: false },
  plugins: {
    // Light icons on the dark app (DARK means "for a dark background").
    SystemBars: { style: 'DARK' },
  },
};

export default config;
