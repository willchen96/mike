import {
  Router,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { checkProjectAccess } from "../lib/access";
import { sendInternalError } from "../lib/httpError";
import {
  enableMemoryFile,
  ensureMemoryFile,
  getMemoryCurrent,
  listMemoryVersions,
  MemoryDisabledError,
  MemoryValidationError,
  MemoryVersionConflictError,
  memoryVersionContent,
  restoreMemoryVersion,
  wipeMemoryFile,
  writeMemoryFile,
  type MemoryFileRow,
  type MemoryScope,
} from "../lib/memory/files";
import { can, type Capability } from "../lib/permissions";
import { createServerSupabase } from "../lib/supabase";
import { requireAuth } from "../middleware/auth";

export const userMemoryRouter = Router();
export const projectMemoryRouter = Router({ mergeParams: true });

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

userMemoryRouter.use(requireAuth);
projectMemoryRouter.use(requireAuth);
const privateNoStore = (_req: Request, res: Response, next: NextFunction) => {
  res.setHeader("Cache-Control", "private, no-store");
  next();
};
userMemoryRouter.use(privateNoStore);
projectMemoryRouter.use(privateNoStore);

type MemoryRequestContext = {
  scope: MemoryScope;
  ownerId: string;
  file: MemoryFileRow;
};

async function userContext(
  _req: Request,
  res: Response,
): Promise<MemoryRequestContext | null> {
  const ownerId = res.locals.userId as string;
  const db = createServerSupabase();
  const file = await ensureMemoryFile(db, "user", ownerId, true);
  return { scope: "user", ownerId, file };
}

function projectContext(required: Capability) {
  return async (
    req: Request,
    res: Response,
  ): Promise<MemoryRequestContext | null> => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const projectId = req.params.projectId;
    const db = createServerSupabase();
    const access = await checkProjectAccess(projectId, userId, userEmail, db);
    if (!access.ok) {
      res.status(404).json({ detail: "Project not found" });
      return null;
    }
    if (!can(access.projectRole, required)) {
      res
        .status(403)
        .json({ detail: "You do not have permission to manage this memory." });
      return null;
    }
    const file = await ensureMemoryFile(db, "project", projectId, true);
    return { scope: "project", ownerId: projectId, file };
  };
}

function expectedVersion(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

async function currentForContext(ctx: MemoryRequestContext) {
  return (
    await getMemoryCurrent(createServerSupabase(), ctx.scope, ctx.ownerId, true)
  ).current;
}

async function sendMemoryError(
  res: Response,
  error: unknown,
  ctx?: MemoryRequestContext,
): Promise<void> {
  if (error instanceof MemoryVersionConflictError && ctx) {
    let current;
    try {
      current = await currentForContext(ctx);
    } catch {
      current = undefined;
    }
    res.status(409).json({
      code: "memory_version_conflict",
      detail:
        "Memory changed since it was loaded. Review the latest version and try again.",
      ...(current ? { current } : {}),
    });
    return;
  }
  if (error instanceof MemoryDisabledError) {
    res.status(409).json({
      code: "memory_disabled",
      detail: "Enable memory before editing it.",
    });
    return;
  }
  if (error instanceof MemoryValidationError) {
    const missing = /not found/i.test(error.message);
    res.status(missing ? 404 : 400).json({ detail: error.message });
    return;
  }
  sendInternalError(res, error);
}

function installMemoryRoutes(
  router: Router,
  readContext: (
    req: Request,
    res: Response,
  ) => Promise<MemoryRequestContext | null>,
  writeContext: (
    req: Request,
    res: Response,
  ) => Promise<MemoryRequestContext | null>,
  settingsContext: (
    req: Request,
    res: Response,
  ) => Promise<MemoryRequestContext | null>,
) {
  router.get("/", async (req, res) => {
    try {
      const ctx = await readContext(req, res);
      if (!ctx) return;
      res.json(await currentForContext(ctx));
    } catch (error) {
      await sendMemoryError(res, error);
    }
  });

  router.get("/memory.md", async (req, res) => {
    try {
      const ctx = await readContext(req, res);
      if (!ctx) return;
      const current = await currentForContext(ctx);
      res.setHeader("Content-Type", "text/markdown; charset=utf-8");
      res.setHeader("Content-Disposition", 'attachment; filename="memory.md"');
      res.send(current.content);
    } catch (error) {
      await sendMemoryError(res, error);
    }
  });

  router.put("/", async (req, res) => {
    let ctx: MemoryRequestContext | null = null;
    try {
      const parsedVersion = expectedVersion(req.body?.expected_version);
      if (parsedVersion == null || typeof req.body?.content !== "string") {
        return void res.status(400).json({
          detail:
            "content and a non-negative integer expected_version are required",
        });
      }
      ctx = await writeContext(req, res);
      if (!ctx) return;
      const current = (
        await writeMemoryFile({
          db: createServerSupabase(),
          file: ctx.file,
          content: req.body.content,
          expectedVersion: parsedVersion,
          source: "manual",
          updatedBy: res.locals.userId as string,
        })
      ).current;
      res.json(current);
    } catch (error) {
      await sendMemoryError(res, error, ctx ?? undefined);
    }
  });

  router.patch("/settings", async (req, res) => {
    try {
      if (typeof req.body?.enabled !== "boolean") {
        return void res
          .status(400)
          .json({ detail: "enabled must be a boolean" });
      }
      const ctx = await settingsContext(req, res);
      if (!ctx) return;
      const current = req.body.enabled
        ? await enableMemoryFile(
            createServerSupabase(),
            ctx.file,
            res.locals.userId as string,
          )
        : await wipeMemoryFile({
            db: createServerSupabase(),
            file: ctx.file,
            enabled: false,
            updatedBy: res.locals.userId as string,
            source: "settings",
          });
      res.json(current);
    } catch (error) {
      await sendMemoryError(res, error);
    }
  });

  router.delete("/", async (req, res) => {
    try {
      const ctx = await settingsContext(req, res);
      if (!ctx) return;
      res.json(
        await wipeMemoryFile({
          db: createServerSupabase(),
          file: ctx.file,
          enabled: null,
          updatedBy: res.locals.userId as string,
          source: "wipe",
        }),
      );
    } catch (error) {
      await sendMemoryError(res, error);
    }
  });

  router.get("/versions", async (req, res) => {
    try {
      const ctx = await readContext(req, res);
      if (!ctx) return;
      res.json({
        versions: await listMemoryVersions(createServerSupabase(), ctx.file.id),
      });
    } catch (error) {
      await sendMemoryError(res, error);
    }
  });

  router.get("/versions/:versionId/memory.md", async (req, res) => {
    try {
      if (!UUID_PATTERN.test(req.params.versionId)) {
        return void res
          .status(404)
          .json({ detail: "Memory version not found" });
      }
      const ctx = await readContext(req, res);
      if (!ctx) return;
      const content = await memoryVersionContent(
        createServerSupabase(),
        ctx.file.id,
        req.params.versionId,
      );
      if (content == null)
        return void res
          .status(404)
          .json({ detail: "Memory version not found" });
      res.setHeader("Content-Type", "text/markdown; charset=utf-8");
      res.setHeader("Content-Disposition", 'attachment; filename="memory.md"');
      res.send(content);
    } catch (error) {
      await sendMemoryError(res, error);
    }
  });

  router.post("/versions/:versionId/restore", async (req, res) => {
    let ctx: MemoryRequestContext | null = null;
    try {
      if (!UUID_PATTERN.test(req.params.versionId)) {
        return void res
          .status(404)
          .json({ detail: "Memory version not found" });
      }
      const parsedVersion = expectedVersion(req.body?.expected_version);
      if (parsedVersion == null) {
        return void res.status(400).json({
          detail: "a non-negative integer expected_version is required",
        });
      }
      ctx = await writeContext(req, res);
      if (!ctx) return;
      res.json(
        await restoreMemoryVersion({
          db: createServerSupabase(),
          file: ctx.file,
          versionId: req.params.versionId,
          expectedVersion: parsedVersion,
          updatedBy: res.locals.userId as string,
        }),
      );
    } catch (error) {
      await sendMemoryError(res, error, ctx ?? undefined);
    }
  });
}

installMemoryRoutes(userMemoryRouter, userContext, userContext, userContext);
installMemoryRoutes(
  projectMemoryRouter,
  projectContext("project.view"),
  projectContext("content.edit"),
  projectContext("access.manage"),
);
