"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ZoomIn, ZoomOut, FileX, RefreshCw } from "lucide-react";
import { MikeIcon } from "@/app/components/chat/mike-icon";
import { useFetchSingleDoc } from "@/app/hooks/useFetchSingleDoc";
import { DocxView } from "./DocxView";
import type { CitationQuote } from "./types";
import {
    clearHighlights,
    getPdfJs,
    highlightQuote,
    STANDARD_FONT_DATA_URL,
} from "./highlightQuote";

interface Props {
    doc: { document_id: string; version_id?: string | null } | null;
    pdfStatus?: "pending" | "ok" | "failed" | null;
    onRetryPdf?: () => void | Promise<void>;
    /** Preferred: one or more (page, quote) pairs to highlight. */
    quotes?: CitationQuote[];
    /** Back-compat single-quote API. Ignored if `quotes` is provided. */
    quote?: string;
    fallbackPage?: number;
    rounded?: boolean;
    bordered?: boolean;
}

type QuoteEntry = { page?: number; quote: string };

const SIDE_PADDING = 20;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3.0;
const ZOOM_STEP = 0.25;

type RenderedPage = {
    page: import("pdfjs-dist").PDFPageProxy;
    viewport: import("pdfjs-dist").PageViewport;
    wrapper: HTMLDivElement;
    canvas: HTMLCanvasElement;
    textDivs: HTMLElement[];
};

export function DocView({
    doc,
    pdfStatus,
    onRetryPdf,
    quotes,
    quote,
    fallbackPage,
    rounded = true,
    bordered = true,
}: Props) {
    const containerRef = useRef<HTMLDivElement>(null);
    const scrollContainerRef = useRef<HTMLDivElement>(null);
    const pdfDocRef = useRef<import("pdfjs-dist").PDFDocumentProxy | null>(
        null,
    );
    const renderedPagesRef = useRef<RenderedPage[]>([]);
    const quoteListRef = useRef<QuoteEntry[]>([]);
    const zoomRef = useRef(1.0);
    const currentPageRef = useRef(1);

    const quoteList: QuoteEntry[] = useMemo(() => {
        if (quotes?.length)
            return quotes.map((q) => ({ page: q.page, quote: q.quote }));
        if (quote) return [{ page: fallbackPage, quote }];
        return [];
    }, [quotes, quote, fallbackPage]);

    // Stable string key so effects can depend on quote-list identity
    const quoteKey = quoteList
        .map((q) => `${q.page ?? ""}:${q.quote}`)
        .join("|");

    const [containerWidth, setContainerWidth] = useState(0);
    const [zoom, setZoom] = useState(1.0);
    const [currentPage, setCurrentPage] = useState(1);
    const [numPages, setNumPages] = useState(0);
    const [retrying, setRetrying] = useState(false);

    const { result, loading, error } = useFetchSingleDoc(
        doc?.document_id ?? null,
        doc?.version_id ?? null,
    );

    // /display returned DOCX bytes — the active version has no PDF
    // rendition, so fall back to docx-preview (still applies citation
    // highlighting via the same `quotes` API).
    const fallbackToDocx = result?.type === "docx";

    const handleRetry = async () => {
        if (!onRetryPdf || retrying) return;
        setRetrying(true);
        try {
            await Promise.resolve(onRetryPdf());
        } finally {
            setRetrying(false);
        }
    };

    // Track container width via ResizeObserver so re-renders fire on resize
    useEffect(() => {
        const el = scrollContainerRef.current;
        if (!el) return;
        const ro = new ResizeObserver((entries) => {
            setContainerWidth(entries[0]?.contentRect.width ?? 0);
        });
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    // Track current page via scroll position
    useEffect(() => {
        const scrollEl = scrollContainerRef.current;
        if (!scrollEl) return;

        const handleScroll = () => {
            const pages = renderedPagesRef.current;
            if (!pages.length) return;
            const scrollCenter = scrollEl.scrollTop + scrollEl.clientHeight / 2;
            let closest = 0;
            let closestDist = Infinity;
            pages.forEach((p, i) => {
                const pageCenter =
                    p.wrapper.offsetTop + p.wrapper.clientHeight / 2;
                const dist = Math.abs(pageCenter - scrollCenter);
                if (dist < closestDist) {
                    closestDist = dist;
                    closest = i;
                }
            });
            currentPageRef.current = closest + 1;
            setCurrentPage(closest + 1);
        };

        scrollEl.addEventListener("scroll", handleScroll, { passive: true });
        return () => scrollEl.removeEventListener("scroll", handleScroll);
    }, []);

    // Highlights all entries in `list` across the already-rendered pages.
    // Returns the 1-based page number of the first successfully highlighted entry, or null.
    const applyHighlights = useCallback(
        async (list: QuoteEntry[]): Promise<number | null> => {
            // Clear any prior highlights across all pages
            for (const p of renderedPagesRef.current)
                clearHighlights(p.textDivs);

            let firstHitPage: number | null = null;
            for (const entry of list) {
                let hitPage: number | null = null;

                if (entry.page) {
                    const target = renderedPagesRef.current[entry.page - 1];
                    if (target) {
                        const found = await highlightQuote(
                            target.textDivs,
                            entry.quote,
                        );
                        if (found) hitPage = entry.page;
                    }
                }

                // Fall back to scanning all pages for this quote
                if (hitPage === null) {
                    console.warn(
                        `Quote not found on hinted page, scanning all pages: "${entry.quote.slice(0, 60)}..."`,
                    );
                    for (let i = 0; i < renderedPagesRef.current.length; i++) {
                        const p = renderedPagesRef.current[i];
                        const found = await highlightQuote(
                            p.textDivs,
                            entry.quote,
                        );
                        if (found) {
                            hitPage = i + 1;
                            break;
                        }
                    }
                }

                if (hitPage !== null && firstHitPage === null) {
                    firstHitPage = hitPage;
                }
            }
            return firstHitPage;
        },
        [],
    );

    const renderPDF = useCallback(
        async (
            doc: import("pdfjs-dist").PDFDocumentProxy,
            list: QuoteEntry[],
            scrollToPage?: number,
        ) => {
            if (!containerRef.current) return;
            containerRef.current.innerHTML = "";
            renderedPagesRef.current = [];
            const lib = await getPdfJs();
            lib.TextLayer.cleanup();

            setNumPages(doc.numPages);
            setCurrentPage(1);
            currentPageRef.current = 1;

            const hasCitation = list.length > 0;
            if (hasCitation && scrollContainerRef.current) {
                scrollContainerRef.current.style.opacity = "0";
            }

            const reveal = () => {
                if (scrollContainerRef.current)
                    scrollContainerRef.current.style.opacity = "1";
            };

            const panelW = containerRef.current.clientWidth;
            const firstPage = await doc.getPage(1);
            const naturalWidth = firstPage.getViewport({ scale: 1 }).width;
            const baseScale = Math.max(
                0.5,
                (panelW - SIDE_PADDING) / naturalWidth,
            );
            const scale = baseScale * zoomRef.current;

            for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
                const page = await doc.getPage(pageNum);
                const viewport = page.getViewport({ scale });

                const wrapper = document.createElement("div");
                wrapper.style.position = "relative";
                wrapper.style.margin = "0 auto 8px";
                wrapper.style.width = "fit-content";
                wrapper.className = "shadow-md";

                const canvas = document.createElement("canvas");
                canvas.width = viewport.width;
                canvas.height = viewport.height;
                canvas.style.display = "block";
                wrapper.appendChild(canvas);
                containerRef.current?.appendChild(wrapper);

                const ctx = canvas.getContext("2d");
                if (!ctx) continue;

                const task = page.render({ canvasContext: ctx, viewport });
                try {
                    await task.promise;
                } catch (e: unknown) {
                    if (
                        (e as { name?: string })?.name !==
                        "RenderingCancelledException"
                    ) {
                        console.error("PDF render error", e);
                    }
                    continue;
                }

                const textLayerDiv = document.createElement("div");
                textLayerDiv.className = "pdf-text-layer";
                textLayerDiv.style.position = "absolute";
                textLayerDiv.style.left = "0";
                textLayerDiv.style.top = "0";
                textLayerDiv.style.width = `${viewport.width}px`;
                textLayerDiv.style.height = `${viewport.height}px`;
                textLayerDiv.style.setProperty("--scale-factor", String(scale));
                wrapper.appendChild(textLayerDiv);

                const textLayer = new lib.TextLayer({
                    textContentSource: page.streamTextContent(),
                    container: textLayerDiv,
                    viewport,
                });
                await textLayer.render();
                const textDivs = textLayer.textDivs;

                renderedPagesRef.current.push({
                    page,
                    viewport,
                    wrapper,
                    canvas,
                    textDivs,
                });
            }

            // Apply highlights across all entries, then scroll to the first hit.
            let targetPage: number | null = null;
            if (list.length) {
                targetPage = await applyHighlights(list);
                if (targetPage === null) {
                    // Fallback: scroll to the first entry's page hint, even without a highlight
                    const hint = list.find((e) => e.page)?.page ?? null;
                    targetPage = hint;
                }
            }
            if (targetPage && targetPage >= 1) {
                scrollToHighlightOnPage(targetPage);
            } else if (!hasCitation && scrollToPage && scrollToPage > 1) {
                // Restore scroll position after zoom re-render
                const pageEntry = renderedPagesRef.current[scrollToPage - 1];
                if (pageEntry)
                    pageEntry.wrapper.scrollIntoView({
                        behavior: "instant" as ScrollBehavior,
                        block: "start",
                    });
            }

            reveal();
        },
        [applyHighlights],
    );

    // Scroll so the first highlight on `pageNum` lands at the vertical center
    // of the viewer. We compute the scroll position explicitly on the scroll
    // container — calling `scrollIntoView` on a child of the absolutely-
    // positioned text layer can scroll just the overlay while leaving the
    // canvas untouched, which is why we don't use it here.
    function scrollToHighlightOnPage(pageNum: number) {
        const pageEntry = renderedPagesRef.current[pageNum - 1];
        const scrollEl = scrollContainerRef.current;
        if (!pageEntry || !scrollEl) return;

        const highlightEl = pageEntry.wrapper.querySelector<HTMLElement>(
            ".pdf-text-highlight",
        );
        if (highlightEl) {
            const containerRect = scrollEl.getBoundingClientRect();
            const highlightRect = highlightEl.getBoundingClientRect();
            const offsetWithinContainer = highlightRect.top - containerRect.top;
            const targetTop =
                scrollEl.scrollTop +
                offsetWithinContainer -
                scrollEl.clientHeight / 2 +
                highlightRect.height / 2;
            scrollEl.scrollTo({
                top: Math.max(0, targetTop),
                behavior: "instant" as ScrollBehavior,
            });
        } else {
            const wrapperRect = pageEntry.wrapper.getBoundingClientRect();
            const containerRect = scrollEl.getBoundingClientRect();
            const targetTop =
                scrollEl.scrollTop + (wrapperRect.top - containerRect.top);
            scrollEl.scrollTo({
                top: Math.max(0, targetTop),
                behavior: "instant" as ScrollBehavior,
            });
        }
    }

    const rehighlightQuotes = useCallback(
        async (list: QuoteEntry[]) => {
            const targetPage = await applyHighlights(list);
            const scrollPage =
                targetPage ?? list.find((e) => e.page)?.page ?? null;
            if (scrollPage && scrollPage >= 1) {
                scrollToHighlightOnPage(scrollPage);
            }
        },
        [applyHighlights],
    );

    // Trackpad pinch-to-zoom (wheel + ctrlKey)
    useEffect(() => {
        const el = scrollContainerRef.current;
        if (!el) return;
        let debounceTimer: ReturnType<typeof setTimeout> | null = null;

        const handleWheel = (e: WheelEvent) => {
            if (!e.ctrlKey) return;
            e.preventDefault();
            const delta = e.deltaMode === 0 ? e.deltaY / 300 : e.deltaY * 0.1;
            const next = Math.min(
                ZOOM_MAX,
                Math.max(
                    ZOOM_MIN,
                    Math.round(zoomRef.current * Math.exp(-delta) * 100) / 100,
                ),
            );
            if (next === zoomRef.current) return;
            zoomRef.current = next;
            setZoom(next);
            if (debounceTimer) clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                if (pdfDocRef.current) {
                    renderPDF(
                        pdfDocRef.current,
                        quoteListRef.current,
                        currentPageRef.current,
                    );
                }
            }, 150);
        };

        el.addEventListener("wheel", handleWheel, { passive: false });
        return () => {
            el.removeEventListener("wheel", handleWheel);
            if (debounceTimer) clearTimeout(debounceTimer);
        };
    }, [renderPDF]);

    // Touch pinch-to-zoom
    useEffect(() => {
        const el = scrollContainerRef.current;
        if (!el) return;
        let initialDist = 0;
        let initialZoom = 1.0;

        function getTouchDist(touches: TouchList) {
            const dx = touches[0].clientX - touches[1].clientX;
            const dy = touches[0].clientY - touches[1].clientY;
            return Math.hypot(dx, dy);
        }

        const handleTouchStart = (e: TouchEvent) => {
            if (e.touches.length === 2) {
                initialDist = getTouchDist(e.touches);
                initialZoom = zoomRef.current;
            }
        };

        const handleTouchMove = (e: TouchEvent) => {
            if (e.touches.length !== 2 || initialDist === 0) return;
            e.preventDefault();
            const next = Math.min(
                ZOOM_MAX,
                Math.max(
                    ZOOM_MIN,
                    Math.round(
                        initialZoom *
                            (getTouchDist(e.touches) / initialDist) *
                            100,
                    ) / 100,
                ),
            );
            zoomRef.current = next;
            setZoom(next);
        };

        const handleTouchEnd = (e: TouchEvent) => {
            if (e.touches.length < 2 && initialDist > 0) {
                initialDist = 0;
                if (pdfDocRef.current) {
                    renderPDF(
                        pdfDocRef.current,
                        quoteListRef.current,
                        currentPageRef.current,
                    );
                }
            }
        };

        el.addEventListener("touchstart", handleTouchStart, { passive: true });
        el.addEventListener("touchmove", handleTouchMove, { passive: false });
        el.addEventListener("touchend", handleTouchEnd, { passive: true });
        return () => {
            el.removeEventListener("touchstart", handleTouchStart);
            el.removeEventListener("touchmove", handleTouchMove);
            el.removeEventListener("touchend", handleTouchEnd);
        };
    }, [renderPDF]);

    // Clean up PDF.js static font-measurement canvases on unmount
    useEffect(() => {
        return () => {
            getPdfJs().then((lib) => lib.TextLayer.cleanup());
        };
    }, []);

    // Render PDF when fetch result arrives
    useEffect(() => {
        if (!result || result.type !== "pdf") return;
        pdfDocRef.current = null;
        renderedPagesRef.current = [];
        quoteListRef.current = quoteList;
        zoomRef.current = 1.0;
        setZoom(1.0);
        setNumPages(0);
        const list = quoteList;

        let cancelled = false;
        (async () => {
            const lib = await getPdfJs();
            if (cancelled) return;
            const pdfDoc = await lib.getDocument({
                data: new Uint8Array(result.buffer),
                standardFontDataUrl: STANDARD_FONT_DATA_URL,
            }).promise;
            if (cancelled) return;
            pdfDocRef.current = pdfDoc;
            await renderPDF(pdfDoc, list);
        })();
        return () => {
            cancelled = true;
        };
    }, [result, renderPDF]); // eslint-disable-line react-hooks/exhaustive-deps

    // Re-render at new scale when container is resized (debounced 150ms)
    useEffect(() => {
        if (!pdfDocRef.current) return;
        const timer = setTimeout(() => {
            if (pdfDocRef.current) {
                renderPDF(pdfDocRef.current, quoteListRef.current);
            }
        }, 150);
        return () => clearTimeout(timer);
    }, [containerWidth, renderPDF]); // eslint-disable-line react-hooks/exhaustive-deps

    // Re-highlight when quotes change without full re-render
    useEffect(() => {
        if (!pdfDocRef.current) return;
        quoteListRef.current = quoteList;
        if (quoteList.length === 0) return;
        rehighlightQuotes(quoteList);
    }, [quoteKey, rehighlightQuotes]); // eslint-disable-line react-hooks/exhaustive-deps

    function handleZoomIn() {
        const next = Math.min(
            ZOOM_MAX,
            Math.round((zoomRef.current + ZOOM_STEP) * 100) / 100,
        );
        zoomRef.current = next;
        setZoom(next);
        if (pdfDocRef.current) {
            renderPDF(
                pdfDocRef.current,
                quoteListRef.current,
                currentPageRef.current,
            );
        }
    }

    function handleZoomOut() {
        const next = Math.max(
            ZOOM_MIN,
            Math.round((zoomRef.current - ZOOM_STEP) * 100) / 100,
        );
        zoomRef.current = next;
        setZoom(next);
        if (pdfDocRef.current) {
            renderPDF(
                pdfDocRef.current,
                quoteListRef.current,
                currentPageRef.current,
            );
        }
    }

    if (fallbackToDocx && doc?.document_id) {
        return (
            <DocxView
                documentId={doc.document_id}
                quotes={quotes}
            />
        );
    }

    return (
        <div
            className={`relative flex flex-col flex-1 overflow-hidden ${bordered ? "border border-gray-200" : ""} ${rounded ? "rounded-xl" : ""}`}
        >
            <div
                ref={scrollContainerRef}
                className="flex-1 overflow-auto bg-gray-100 px-3 pt-5 pb-3"
            >
                {loading && (
                    <div className="flex h-full items-center justify-center">
                        <MikeIcon spin mike size={28} />
                    </div>
                )}
                {error && (
                    <div className="flex h-full items-center justify-center">
                        <p className="text-sm text-red-500">{error}</p>
                    </div>
                )}
                {!loading && !error && !result && pdfStatus === "pending" && (
                    <div className="flex h-full flex-col items-center justify-center gap-3">
                        <MikeIcon spin mike size={28} />
                        <p className="text-sm font-medium text-gray-700">Generating preview&#8230;</p>
                        <p className="text-xs text-gray-500 text-center max-w-xs">
                            The PDF preview is being prepared. This usually takes a few seconds.
                        </p>
                    </div>
                )}
                {!loading && !error && !result && pdfStatus === "failed" && (
                    <div className="flex h-full flex-col items-center justify-center gap-3">
                        <FileX className="h-8 w-8 text-gray-400" />
                        <p className="text-sm font-medium text-gray-700">Preview unavailable</p>
                        <p className="text-xs text-gray-500 text-center max-w-xs">
                            The PDF preview could not be generated.
                        </p>
                        {onRetryPdf && (
                            <button
                                onClick={handleRetry}
                                disabled={retrying}
                                className="mt-4 flex items-center gap-2 rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-50"
                            >
                                <RefreshCw className="h-3.5 w-3.5" />
                                {retrying ? "Retrying…" : "Retry preview"}
                            </button>
                        )}
                    </div>
                )}
                <div ref={containerRef} />
            </div>
            {numPages > 0 && (
                <>
                    {/* Page counter — bottom left */}
                    <div className="absolute bottom-4 left-4 pointer-events-none">
                        <span className="flex items-center px-3 py-1.5 rounded-full text-xs font-medium tabular-nums text-gray-700 bg-white/25 backdrop-blur-md border border-white/30 shadow-md">
                            {currentPage}/{numPages}
                        </span>
                    </div>

                    {/* Zoom controls — bottom right */}
                    <div className="absolute bottom-4 right-4 flex items-center gap-px rounded-full bg-white/25 backdrop-blur-md border border-white/30 shadow-md px-1 py-1">
                        <button
                            onClick={handleZoomOut}
                            disabled={zoom <= ZOOM_MIN}
                            className="flex items-center justify-center w-7 h-7 rounded-full text-gray-600 hover:bg-white/80 disabled:opacity-30 transition-colors"
                        >
                            <ZoomOut className="h-3.5 w-3.5" />
                        </button>
                        <span className="text-xs font-medium text-gray-600 tabular-nums w-9 text-center select-none">
                            {Math.round(zoom * 100)}%
                        </span>
                        <button
                            onClick={handleZoomIn}
                            disabled={zoom >= ZOOM_MAX}
                            className="flex items-center justify-center w-7 h-7 rounded-full text-gray-600 hover:bg-white/80 disabled:opacity-30 transition-colors"
                        >
                            <ZoomIn className="h-3.5 w-3.5" />
                        </button>
                    </div>
                </>
            )}
        </div>
    );
}
