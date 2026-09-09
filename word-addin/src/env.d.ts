/// <reference types="office-js" />

/**
 * Ambient declaration for webpack EnvironmentPlugin substitutions.
 * These values are replaced while webpack builds the task-pane bundle.
 */
declare const process: {
  readonly env: {
    readonly REACT_APP_API_BASE_URL: string | undefined;
    readonly REACT_APP_DEFAULT_MODEL: string | undefined;
    readonly REACT_APP_WEB_APP_URL: string | undefined;
    readonly REACT_APP_SENTRY_DSN: string | undefined;
    readonly REACT_APP_SENTRY_ENVIRONMENT: string | undefined;
    readonly REACT_APP_SENTRY_RELEASE: string | undefined;
    readonly REACT_APP_SENTRY_TRACES_SAMPLE_RATE: string | undefined;
    readonly NODE_ENV: string;
  };
};
