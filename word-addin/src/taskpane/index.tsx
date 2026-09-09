/// <reference types="office-js" />
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";
import {
  ErrorBoundary,
  initAddinErrorReporting,
  reportError,
  tagOfficeHost,
} from "./lib/errorReporting";
import { PaneErrorFallback } from "./components/shell/PaneErrorFallback";

// Before Office.onReady: an error while Office.js itself boots the pane is
// still an error we want to hear about.
initAddinErrorReporting("taskpane");

Office.onReady(() => {
  tagOfficeHost();
  const container = document.getElementById("root");
  if (!container) {
    const missingRoot = new Error("Root element #root not found in DOM");
    reportError(missingRoot, { level: "fatal", tags: { component: "boot" } });
    throw missingRoot;
  }
  const root = createRoot(container);
  root.render(
    // `@container` makes the whole pane a query container so descendants can
    // adapt spacing/type to the (resizable, usually narrow) task-pane width
    // via `@sm:`/`@md:` variants — viewport breakpoints never fire in a pane.
    <div className="@container h-full w-full bg-background text-foreground font-sans antialiased">
      <ErrorBoundary
        fallback={({ resetError }) => (
          <PaneErrorFallback resetError={resetError} />
        )}
      >
        <App />
      </ErrorBoundary>
    </div>
  );
});
