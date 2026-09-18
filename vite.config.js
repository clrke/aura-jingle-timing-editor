import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
// GitHub Pages project site: https://clrke.github.io/aura-jingle-timing-editor/
export default defineConfig({
    plugins: [react()],
    base: '/aura-jingle-timing-editor/',
});
