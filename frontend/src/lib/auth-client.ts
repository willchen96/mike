import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({
    baseURL: process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001",
});
