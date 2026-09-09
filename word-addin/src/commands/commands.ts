/// <reference types="office-js" />
import { initAddinErrorReporting } from "../taskpane/lib/errorReporting";

initAddinErrorReporting("commands");

Office.onReady(() => {
  // no-op — ribbon commands are handled by the task pane
});
