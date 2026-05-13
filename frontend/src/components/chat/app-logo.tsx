"use client";

import React from "react";
import Image from "next/image";
import { MikeIcon } from "./mike-icon";
import { BRAND } from "@/config/brand";

interface AppLogoProps {
    size?: number;
    style?: React.CSSProperties;
    className?: string;
}

/**
 * Logo da aplicação.
 * Renderiza a imagem definida em NEXT_PUBLIC_LOGO_URL se configurada,
 * ou o ícone SVG padrão caso contrário.
 */
export function AppLogo({ size = 24, style, className }: AppLogoProps) {
    if (BRAND.logoUrl) {
        return (
            <Image
                src={BRAND.logoUrl}
                alt={BRAND.name}
                width={size}
                height={size}
                style={{ display: "block", ...style }}
                className={className}
            />
        );
    }
    return <MikeIcon size={size} style={style} />;
}
