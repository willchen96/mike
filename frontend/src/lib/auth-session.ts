import { authClient } from "@/lib/auth-client";

function toCompatSession(data: any) {
    if (!data?.session || !data?.user) return null;
    return {
        ...data.session,
        access_token: "",
        user: data.user,
    };
}

async function getSession() {
    const result = await authClient.getSession();
    return {
        data: {
            session: toCompatSession(result.data),
        },
        error: result.error,
    };
}

export const authSession = {
    auth: {
        getSession,
        async signInWithPassword({
            email,
            password,
        }: {
            email: string;
            password: string;
        }) {
            const result = await authClient.signIn.email({ email, password });
            return {
                data: {
                    session: toCompatSession(result.data),
                },
                error: result.error,
            };
        },
        async signUp({ email, password }: { email: string; password: string }) {
            const result = await authClient.signUp.email({
                email,
                password,
                name: email,
            });
            return {
                data: {
                    session: toCompatSession(result.data),
                },
                error: result.error,
            };
        },
        signOut() {
            return authClient.signOut();
        },
        onAuthStateChange() {
            return {
                data: {
                    subscription: {
                        unsubscribe() {},
                    },
                },
            };
        },
    },
};
