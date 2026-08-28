import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Analytics } from '@vercel/analytics/react';
import { SpeedInsights } from '@vercel/speed-insights/react';
import './index.css';
import App from './App';

const host = document.getElementById('root');
if (!host) throw new Error('Root element #root not found');

/*
 * Analytics and Speed Insights are the /react entry points, not /next: this is
 * a Vite SPA and the Next.js imports the Vercel dashboard suggests would fail
 * to resolve.
 *
 * Both render nothing and inject a deferred script, so neither is on the
 * critical path. They no-op outside a Vercel deployment, which keeps local
 * development free of beacons.
 */
createRoot(host).render(
  <StrictMode>
    <App />
    <Analytics />
    <SpeedInsights />
  </StrictMode>,
);
