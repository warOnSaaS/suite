// Vercel function: every request (see vercel.json). The suite itself is in dist/server (npm run build).
export { default } from '../dist/server/vercel.mjs';
export const config = { maxDuration: 60 };
