import { Request, Response, NextFunction } from "express";
import { createServerSupabase } from "../lib/supabase";

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!token) {
    res.status(401).json({ detail: "Not authenticated" });
    return;
  }

  const db = createServerSupabase();
  const { data: { user }, error } = await db.auth.getUser(token);

  if (error || !user) {
    res.status(401).json({ detail: "Invalid or expired session" });
    return;
  }

  res.locals.userId    = user.id;
  res.locals.userEmail = user.email ?? "";
  res.locals.token     = token;
  next();
}
