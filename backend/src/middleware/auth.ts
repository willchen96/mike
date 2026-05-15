import { Request, Response, NextFunction } from "express";
import { fromNodeHeaders } from "better-auth/node";
import { auth } from "../lib/auth";

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const session = await auth.api.getSession({
    headers: fromNodeHeaders(req.headers),
  });
  if (!session?.user) {
    res.status(401).json({ detail: "Invalid or expired token" });
    return;
  }

  res.locals.userId = session.user.id;
  res.locals.userEmail = session.user.email?.toLowerCase() ?? "";
  next();
}
