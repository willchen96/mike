"use client";

import React, { useId } from "react";

const DEGREES = [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330];
const STOP_TRANSITION = "stop-color 220ms ease, stop-opacity 220ms ease";
const FLOOD_TRANSITION = "flood-color 220ms ease, flood-opacity 220ms ease";

type IconPalette = {
    shadowColor: string;
    shadowOpacity: number;
    fillStops: [string, string, string, string];
    fillOpacities: [number, number, number, number];
    specularStops: [number, number, number, number];
    borderStops: [string, string, string];
    borderOpacities: [number, number, number];
    innerStops: [string, string, string, string];
    innerOpacities: [number, number, number, number];
};

const DEFAULT_PALETTE: IconPalette = {
    shadowColor: "#000000",
    shadowOpacity: 0.3,
    fillStops: ["#0a0a0a", "#151515", "#080808", "#111111"],
    fillOpacities: [0.9, 0.8, 0.85, 0.9],
    specularStops: [0.5, 0.2, 0, 0],
    borderStops: ["#ffffff", "#666666", "#ffffff"],
    borderOpacities: [0.3, 0.1, 0.2],
    innerStops: ["#ffffff", "#777777", "#222222", "#ffffff"],
    innerOpacities: [0, 0.08, 0.05, 0],
};

const DONE_PALETTE: IconPalette = {
    shadowColor: "#166534",
    shadowOpacity: 0.18,
    fillStops: ["#4ade80", "#86efac", "#22c55e", "#bbf7d0"],
    fillOpacities: [0.95, 0.88, 0.9, 0.94],
    specularStops: [0.68, 0.32, 0.03, 0],
    borderStops: ["#f0fdf4", "#86efac", "#dcfce7"],
    borderOpacities: [0.42, 0.24, 0.3],
    innerStops: ["#ffffff", "#dcfce7", "#4ade80", "#ffffff"],
    innerOpacities: [0, 0.16, 0.08, 0],
};

const ERROR_PALETTE: IconPalette = {
    shadowColor: "#991b1b",
    shadowOpacity: 0.18,
    fillStops: ["#f87171", "#fca5a5", "#ef4444", "#fecaca"],
    fillOpacities: [0.95, 0.88, 0.9, 0.94],
    specularStops: [0.68, 0.32, 0.03, 0],
    borderStops: ["#fef2f2", "#fca5a5", "#fee2e2"],
    borderOpacities: [0.42, 0.24, 0.3],
    innerStops: ["#ffffff", "#fee2e2", "#f87171", "#ffffff"],
    innerOpacities: [0, 0.16, 0.08, 0],
};

function Blades({ ids }: { ids: Record<string, string> }) {
    return (
        <g transform="translate(250, 250)">
            {DEGREES.map((deg) => (
                <g
                    key={deg}
                    transform={`rotate(${deg})`}
                    filter={`url(#${ids.shadow})`}
                >
                    <use
                        href={`#${ids.blade}`}
                        fill={`url(#${ids.glassFill})`}
                    />
                    <use
                        href={`#${ids.blade}`}
                        fill={`url(#${ids.innerLight})`}
                    />
                    <use
                        href={`#${ids.blade}`}
                        fill={`url(#${ids.specular})`}
                        clipPath={`url(#${ids.topClip})`}
                    />
                    <use
                        href={`#${ids.blade}`}
                        fill="none"
                        stroke={`url(#${ids.glassBorder})`}
                        strokeWidth="0.8"
                    />
                </g>
            ))}
        </g>
    );
}

export function MikeIcon({
    spin = false,
    done = false,
    error = false,
    mike = false,
    size = 24,
    style,
}: {
    spin?: boolean;
    done?: boolean;
    error?: boolean;
    mike?: boolean;
    size?: number;
    style?: React.CSSProperties;
}) {
    void mike;
    const id = useId().replace(/:/g, "");
    const palette = error
        ? ERROR_PALETTE
        : done
          ? DONE_PALETTE
          : DEFAULT_PALETTE;
    const m = {
        shadow: `${id}-m-shadow`,
        glassFill: `${id}-m-glassFill`,
        specular: `${id}-m-specular`,
        glassBorder: `${id}-m-glassBorder`,
        innerLight: `${id}-m-innerLight`,
        topClip: `${id}-m-topClip`,
        blade: `${id}-m-blade`,
    };

    return (
        <span
            className="shrink-0 inline-block animate-[spin_3s_linear_infinite]"
            style={{
                animationPlayState: spin ? "running" : "paused",
                ...style,
            }}
        >
            <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="100 100 300 300"
                width={size}
                height={size}
                style={{ display: "block" }}
            >
                <defs>
                    <filter
                        id={m.shadow}
                        x="-20%"
                        y="-20%"
                        width="140%"
                        height="140%"
                    >
                        <feDropShadow
                            dx="0"
                            dy="1.5"
                            stdDeviation="3"
                            floodColor={palette.shadowColor}
                            floodOpacity={palette.shadowOpacity}
                            style={{ transition: FLOOD_TRANSITION }}
                        />
                    </filter>
                    <linearGradient
                        id={m.glassFill}
                        x1="0%"
                        y1="0%"
                        x2="100%"
                        y2="100%"
                    >
                        <stop
                            offset="0%"
                            style={{
                                stopColor: palette.fillStops[0],
                                stopOpacity: palette.fillOpacities[0],
                                transition: STOP_TRANSITION,
                            }}
                        />
                        <stop
                            offset="30%"
                            style={{
                                stopColor: palette.fillStops[1],
                                stopOpacity: palette.fillOpacities[1],
                                transition: STOP_TRANSITION,
                            }}
                        />
                        <stop
                            offset="70%"
                            style={{
                                stopColor: palette.fillStops[2],
                                stopOpacity: palette.fillOpacities[2],
                                transition: STOP_TRANSITION,
                            }}
                        />
                        <stop
                            offset="100%"
                            style={{
                                stopColor: palette.fillStops[3],
                                stopOpacity: palette.fillOpacities[3],
                                transition: STOP_TRANSITION,
                            }}
                        />
                    </linearGradient>
                    <linearGradient
                        id={m.specular}
                        x1="0%"
                        y1="0%"
                        x2="0%"
                        y2="100%"
                    >
                        <stop
                            offset="0%"
                            style={{
                                stopColor: "#ffffff",
                                stopOpacity: palette.specularStops[0],
                                transition: STOP_TRANSITION,
                            }}
                        />
                        <stop
                            offset="15%"
                            style={{
                                stopColor: "#ffffff",
                                stopOpacity: palette.specularStops[1],
                                transition: STOP_TRANSITION,
                            }}
                        />
                        <stop
                            offset="35%"
                            style={{
                                stopColor: "#ffffff",
                                stopOpacity: palette.specularStops[2],
                                transition: STOP_TRANSITION,
                            }}
                        />
                        <stop
                            offset="100%"
                            style={{
                                stopColor: "#ffffff",
                                stopOpacity: palette.specularStops[3],
                                transition: STOP_TRANSITION,
                            }}
                        />
                    </linearGradient>
                    <linearGradient
                        id={m.glassBorder}
                        x1="0%"
                        y1="0%"
                        x2="0%"
                        y2="100%"
                    >
                        <stop
                            offset="0%"
                            style={{
                                stopColor: palette.borderStops[0],
                                stopOpacity: palette.borderOpacities[0],
                                transition: STOP_TRANSITION,
                            }}
                        />
                        <stop
                            offset="50%"
                            style={{
                                stopColor: palette.borderStops[1],
                                stopOpacity: palette.borderOpacities[1],
                                transition: STOP_TRANSITION,
                            }}
                        />
                        <stop
                            offset="100%"
                            style={{
                                stopColor: palette.borderStops[2],
                                stopOpacity: palette.borderOpacities[2],
                                transition: STOP_TRANSITION,
                            }}
                        />
                    </linearGradient>
                    <linearGradient
                        id={m.innerLight}
                        x1="100%"
                        y1="0%"
                        x2="0%"
                        y2="100%"
                    >
                        <stop
                            offset="0%"
                            style={{
                                stopColor: palette.innerStops[0],
                                stopOpacity: palette.innerOpacities[0],
                                transition: STOP_TRANSITION,
                            }}
                        />
                        <stop
                            offset="40%"
                            style={{
                                stopColor: palette.innerStops[1],
                                stopOpacity: palette.innerOpacities[1],
                                transition: STOP_TRANSITION,
                            }}
                        />
                        <stop
                            offset="60%"
                            style={{
                                stopColor: palette.innerStops[2],
                                stopOpacity: palette.innerOpacities[2],
                                transition: STOP_TRANSITION,
                            }}
                        />
                        <stop
                            offset="100%"
                            style={{
                                stopColor: palette.innerStops[3],
                                stopOpacity: palette.innerOpacities[3],
                                transition: STOP_TRANSITION,
                            }}
                        />
                    </linearGradient>
                    <clipPath id={m.topClip}>
                        <rect x="30" y="-25" width="130" height="23" />
                    </clipPath>
                    <path
                        id={m.blade}
                        d="M 40,0 A 4,4 0 0 1 43,-3 Q 95,-22 147,-3 A 4,4 0 0 1 150,0 A 4,4 0 0 1 147,3 Q 95,22 43,3 A 4,4 0 0 1 40,0 Z"
                    />
                </defs>

                <Blades ids={m} />
            </svg>
        </span>
    );
}
