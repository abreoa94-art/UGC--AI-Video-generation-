
import * as Sentry from "@sentry/node";

Sentry.init({
  dsn: "https://43b246fc001c0e94690be01d561eabb3@o4510737959026688.ingest.us.sentry.io/4510737964466176",
  // Setting this option to true will send default PII data to Sentry.
  // For example, automatic IP address collection on events
  sendDefaultPii: true,
});