"use client";

import {
    forwardRef,
    useEffect,
    useRef,
    useState,
    type ComponentPropsWithoutRef,
} from "react";
import { createPortal } from "react-dom";
import {
    Download,
    Eye,
    EyeOff,
    FolderMinus,
    Hash,
    History,
    Pencil,
    Trash2,
    Upload,
    X,
} from "lucide-react";
import { SubfolderSvgIcon } from "@/app/components/shared/FolderSvgIcon";
import {
    CLOSE_ROW_ACTIONS_EVENT,
    closeRowActionMenus,
} from "@/app/components/shared/TablePrimitive";
import {
    LiquidDropdownButton,
    LiquidDropdownSurface,
} from "@/app/components/ui/liquid-dropdown";
import { cn } from "@/app/lib/utils";
import { LIQUID_GLASS_HOVER_CLASS } from "@/app/components/ui/liquid-surface";

export { CLOSE_ROW_ACTIONS_EVENT, closeRowActionMenus };

export type RowActionMenuSurfaceProps = ComponentPropsWithoutRef<"div">;

interface Props {
    onDeselect?: () => void;
    onView?: () => void;
    onDelete?: () => void | Promise<void>;
    onHide?: () => void;
    onUnhide?: () => void;
    onDownload?: () => void;
    onRemoveFromFolder?: () => void;
    onShowAllVersions?: () => void;
    onUploadNewVersion?: () => void;
    onNewSubfolder?: () => void;
    /**
     * Offered but refused: the caller's role cannot organize folders here.
     * Shown disabled rather than hidden, so the menu is the same shape for
     * everybody and the reason is legible — the same treatment Delete has.
     */
    newSubfolderDisabled?: boolean;
    deleting?: boolean;
    deleteDisabled?: boolean;
    onEditDetails?: () => void;
    onRename?: () => void;
    onUpdateCmNumber?: () => void;
    viewLabel?: string;
    editDetailsLabel?: string;
    newSubfolderLabel?: string;
    renameLabel?: string;
    uploadNewVersionLabel?: string;
    deleteLabel?: string;
}
type RowActionMenuItemsProps = Props & {
    onClose: () => void;
    surfaceProps?: RowActionMenuSurfaceProps;
};

const ROW_ACTION_ITEM_CLASS =
    "flex items-center gap-2 w-full px-3 py-2 text-gray-600";
const ROW_ACTION_LEFT_ITEM_CLASS = `text-left ${ROW_ACTION_ITEM_CLASS}`;

export const RowActionMenuItems = forwardRef<
    HTMLDivElement,
    RowActionMenuItemsProps
>(function RowActionMenuItems({
    onDeselect,
    onView,
    onDelete,
    onHide,
    onUnhide,
    onDownload,
    onRemoveFromFolder,
    onShowAllVersions,
    onUploadNewVersion,
    onNewSubfolder,
    newSubfolderDisabled = false,
    deleting,
    deleteDisabled = false,
    onEditDetails,
    onRename,
    onUpdateCmNumber,
    viewLabel = "View",
    editDetailsLabel = "Edit details",
    newSubfolderLabel = "New subfolder",
    renameLabel = "Rename",
    uploadNewVersionLabel = "Upload new version",
    deleteLabel = "Delete",
    onClose,
    surfaceProps,
}, ref) {
    const { className: surfaceClassName, ...restSurfaceProps } =
        surfaceProps ?? {};

    return (
        <LiquidDropdownSurface
            ref={ref}
            className={cn("w-48 overflow-hidden", surfaceClassName)}
            {...restSurfaceProps}
        >
            {onDeselect && (
                <LiquidDropdownButton
                    onClick={() => { onClose(); onDeselect(); }}
                    className={ROW_ACTION_LEFT_ITEM_CLASS}
                >
                    <X className="h-3.5 w-3.5 shrink-0" />
                    Deselect rows
                </LiquidDropdownButton>
            )}
            {onView && (
                <LiquidDropdownButton
                    onClick={() => { onClose(); onView(); }}
                    className={ROW_ACTION_ITEM_CLASS}
                >
                    <Eye className="h-3.5 w-3.5" />
                    {viewLabel}
                </LiquidDropdownButton>
            )}
            {onNewSubfolder && (
                <LiquidDropdownButton
                    onClick={() => {
                        if (newSubfolderDisabled) return;
                        onClose();
                        onNewSubfolder();
                    }}
                    disabled={newSubfolderDisabled}
                    aria-disabled={newSubfolderDisabled || undefined}
                    className={cn(
                        ROW_ACTION_LEFT_ITEM_CLASS,
                        newSubfolderDisabled &&
                            "cursor-not-allowed opacity-40 hover:bg-transparent",
                    )}
                >
                    <SubfolderSvgIcon className="h-3.5 w-3.5 shrink-0" />
                    {newSubfolderLabel}
                </LiquidDropdownButton>
            )}
            {onRename && (
                <LiquidDropdownButton
                    onClick={() => { onClose(); onRename(); }}
                    className={ROW_ACTION_ITEM_CLASS}
                >
                    <Pencil className="h-3.5 w-3.5" />
                    {renameLabel}
                </LiquidDropdownButton>
            )}
            {onEditDetails && (
                <LiquidDropdownButton
                    onClick={() => { onClose(); onEditDetails(); }}
                    className={ROW_ACTION_ITEM_CLASS}
                >
                    <Pencil className="h-3.5 w-3.5" />
                    {editDetailsLabel}
                </LiquidDropdownButton>
            )}
            {onUpdateCmNumber && (
                <LiquidDropdownButton
                    onClick={() => { onClose(); onUpdateCmNumber(); }}
                    className={ROW_ACTION_ITEM_CLASS}
                >
                    <Hash className="h-3.5 w-3.5" />
                    Edit CM No.
                </LiquidDropdownButton>
            )}
            {onDownload && (
                <LiquidDropdownButton
                    onClick={() => { onClose(); onDownload(); }}
                    className={ROW_ACTION_ITEM_CLASS}
                >
                    <Download className="h-3.5 w-3.5" />
                    Download
                </LiquidDropdownButton>
            )}
            {onShowAllVersions && (
                <LiquidDropdownButton
                    onClick={() => { onClose(); onShowAllVersions(); }}
                    className={ROW_ACTION_LEFT_ITEM_CLASS}
                >
                    <History className="h-3.5 w-3.5 shrink-0" />
                    Show all versions
                </LiquidDropdownButton>
            )}
            {onUploadNewVersion && (
                <LiquidDropdownButton
                    onClick={() => { onClose(); onUploadNewVersion(); }}
                    className={ROW_ACTION_LEFT_ITEM_CLASS}
                >
                    <Upload className="h-3.5 w-3.5 shrink-0" />
                    {uploadNewVersionLabel}
                </LiquidDropdownButton>
            )}
            {onRemoveFromFolder && (
                <LiquidDropdownButton
                    onClick={() => { onClose(); onRemoveFromFolder(); }}
                    className={ROW_ACTION_LEFT_ITEM_CLASS}
                >
                    <FolderMinus className="h-3.5 w-3.5 shrink-0" />
                    Remove from subfolder
                </LiquidDropdownButton>
            )}
            {onUnhide && (
                <LiquidDropdownButton
                    onClick={() => { onClose(); onUnhide(); }}
                    className={ROW_ACTION_ITEM_CLASS}
                >
                    <Eye className="h-3.5 w-3.5" />
                    Activate
                </LiquidDropdownButton>
            )}
            {onHide && (
                <LiquidDropdownButton
                    onClick={() => { onClose(); onHide(); }}
                    className={ROW_ACTION_ITEM_CLASS}
                >
                    <EyeOff className="h-3.5 w-3.5" />
                    Deactivate
                </LiquidDropdownButton>
            )}
            {onDelete && (
                <button
                    onClick={() => {
                        if (deleteDisabled || deleting) return;
                        onClose();
                        // The menu closes immediately, so an async handler that
                        // rejects has nothing left to report to. Swallow it here
                        // rather than leaving an unhandled rejection; surfaces
                        // that can explain the failure do so themselves.
                        void Promise.resolve(onDelete()).catch((error) => {
                            console.error("row delete action failed", error);
                        });
                    }}
                    disabled={deleting || deleteDisabled}
                    className={`flex items-center gap-2 w-full px-3 py-2 text-xs text-red-500 transition-colors disabled:opacity-40 ${
                        deleteDisabled
                            ? "cursor-not-allowed opacity-40 hover:bg-transparent"
                            : "hover:bg-red-500/10"
                    }`}
                >
                    <Trash2 className="h-3.5 w-3.5" />
                    {deleteLabel}
                </button>
            )}
        </LiquidDropdownSurface>
    );
});

export function RowActions(props: Props) {
    const [open, setOpen] = useState(false);
    const [coords, setCoords] = useState({ top: 0, right: 0 });
    const btnRef = useRef<HTMLButtonElement>(null);

    useEffect(() => {
        if (!open) return;
        function handleClick() {
            setOpen(false);
        }
        document.addEventListener("click", handleClick);
        return () => document.removeEventListener("click", handleClick);
    }, [open]);

    useEffect(() => {
        function handleCloseRowActions() {
            setOpen(false);
        }
        document.addEventListener(CLOSE_ROW_ACTIONS_EVENT, handleCloseRowActions);
        return () =>
            document.removeEventListener(
                CLOSE_ROW_ACTIONS_EVENT,
                handleCloseRowActions,
            );
    }, []);

    function handleToggle(e: React.MouseEvent) {
        e.stopPropagation();
        if (open) {
            setOpen(false);
            return;
        }
        closeRowActionMenus();
        if (btnRef.current) {
            const rect = btnRef.current.getBoundingClientRect();
            setCoords({
                top: rect.bottom + 4,
                right: window.innerWidth - rect.right,
            });
        }
        setOpen(true);
    }

    return (
        <>
            <button
                ref={btnRef}
                type="button"
                aria-label="Open row actions"
                onClick={handleToggle}
                className={`flex items-center justify-center w-6 h-6 rounded text-gray-700 hover:text-gray-900 transition-colors leading-none ${LIQUID_GLASS_HOVER_CLASS}`}
            >
                <span aria-hidden className="tracking-widest text-xs">···</span>
            </button>

            {open &&
                createPortal(
                    <RowActionMenuItems
                        {...props}
                        onClose={() => setOpen(false)}
                        surfaceProps={{
                            style: {
                                position: "fixed",
                                top: coords.top,
                                right: coords.right,
                            },
                            className: "z-[120]",
                            onClick: (e) => e.stopPropagation(),
                        }}
                    />,
                    document.body,
                )}
        </>
    );
}
