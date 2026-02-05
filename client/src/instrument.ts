import * as Sentry from '@sentry/react'

const dsn = import.meta.env.VITE_SENTRY_DSN

if (dsn) {
  Sentry.init({
    dsn,
    sendDefaultPii: true,

    integrations: [Sentry.browserTracingIntegration(), Sentry.replayIntegration()],
    tracesSampleRate: 0.2,
    tracePropagationTargets: [/^\//],

    replaysSessionSampleRate: 0.1,
    replaysOnErrorSampleRate: 1.0,

    enableLogs: true,
  })
} else if (import.meta.env.DEV) {
  // Avoid noise in production if DSN isn't configured
  console.warn('[Sentry] VITE_SENTRY_DSN is not set; Sentry is disabled.')
}
