import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './wos.css';

createRoot(document.getElementById('root')!).render(<App />);

// The installable app (PWA): offline shell and Web Push alerts.
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
