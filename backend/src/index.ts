import { app } from "./app";
import { resetStuckPendingConversions } from "./lib/pdfQueue";
import { resetStuckRunningJobs, startAccountDeletionWorker } from "./lib/accountDeletionWorker";
import { logger } from "./lib/logger";

const PORT = process.env.PORT ?? 3001;

void resetStuckPendingConversions();
void resetStuckRunningJobs();
startAccountDeletionWorker();

app.listen(PORT, () => {
  logger.info({ port: PORT }, "Hugo backend running");
});
