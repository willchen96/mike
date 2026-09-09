"use client";

import { useCallback, useState } from "react";
import { AccessModal } from "@/app/components/modals/AccessModal";
import { useAuth } from "@/app/contexts/AuthContext";
import {
    getChatAccess,
    getChatPeople,
    grantChatAccess,
    revokeChatAccess,
    type ContentAccess,
} from "@/app/lib/mikeApi";
import { can, roleFrom } from "@/app/lib/permissions";
import { userFacingApiError } from "@/app/lib/userFacingError";
import type { Chat } from "@/app/components/shared/types";

interface Props {
    open: boolean;
    chat: Chat;
    onClose: () => void;
}

export function ChatAccessModal({ open, chat, onClose }: Props) {
    const { user } = useAuth();
    const [accessState, setAccessState] = useState<{
        chatId: string;
        value: ContentAccess;
    } | null>(null);
    const [accessError, setAccessError] = useState<string | null>(null);
    const access =
        accessState?.chatId === chat.id ? accessState.value : null;
    const canManage = can(roleFrom(chat), "access.manage");

    const refreshAccess = useCallback(async () => {
        const nextAccess = await getChatAccess(chat.id);
        setAccessState({ chatId: chat.id, value: nextAccess });
    }, [chat.id]);

    /**
     * Load the roster, and for a manager the grants as well.
     *
     * The owner-only grant fetch used to run in its own effect whose `.catch`
     * was a comment. When it failed, `access` stayed null, `canManage &&
     * access !== null` fell to false, and the owner got a modal that was
     * silently read-only with nothing on screen saying why — so it moved in
     * here to share the modal's error line.
     *
     * Chained, though, the two requests became one: `canManage` is derived
     * from the row the CLIENT holds, which can be more generous than the
     * server's answer (a stale sidebar row, an access change in another tab).
     * The grants call then 403s, the whole promise rejects, the roster is
     * discarded with it, and the modal tells somebody who can plainly see the
     * chat that "No one has access yet" — a false statement, and the worse
     * one of the two failures. The roster stands on its own now; a refused
     * grants fetch drops management and says so beside the people it could
     * still load.
     */
    const loadPeople = useCallback(
        async (chatId: string) => {
            const people = await getChatPeople(chatId);
            if (!canManage) {
                setAccessError(null);
                return people;
            }
            try {
                const nextAccess = await getChatAccess(chatId);
                setAccessState({ chatId, value: nextAccess });
                setAccessError(null);
            } catch (cause) {
                setAccessError(
                    userFacingApiError(
                        cause,
                        "Sharing details could not be loaded, so access cannot be changed here.",
                    ),
                );
            }
            return people;
        },
        [canManage],
    );

    return (
        <AccessModal
            open={open}
            onClose={onClose}
            resource={{
                id: chat.id,
                owner_display_name: chat.creator_display_name ?? null,
            }}
            fetchAccess={loadPeople}
            currentUserEmail={user?.email ?? null}
            // The one caller that omitted this. The editor keeps the viewer's
            // own row read-only by id first and email second, and a roster row
            // for the signed-in user can arrive with a null email — which left
            // the owner able to aim Remove at themselves.
            currentUserId={user?.id ?? null}
            breadcrumb={[
                "Assistant",
                chat.title?.trim() || "Untitled chat",
                "Access",
            ]}
            access={{
                grants: access?.grants ?? [],
                orgId: access?.org_id ?? chat.org_id ?? null,
                inheritedFromProjectId:
                    access?.inherited_from_project_id ??
                    chat.project_id ??
                    null,
                ownerLabel: "Owners",
                canManage: canManage && access !== null,
                error: accessError,
                onGrant: async (email, role) => {
                    await grantChatAccess(chat.id, email, role);
                    await refreshAccess();
                },
                onRevoke: async (email) => {
                    await revokeChatAccess(chat.id, email);
                    await refreshAccess();
                },
            }}
        />
    );
}
