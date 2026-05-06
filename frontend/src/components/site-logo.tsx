import Link from "next/link";

interface SiteLogoProps {
    size?: "sm" | "md" | "lg" | "xl";
    className?: string;
    animate?: boolean;
    asLink?: boolean;
}

export function SiteLogo({
    size = "md",
    className = "",
    animate = false,
    asLink = false,
}: SiteLogoProps) {
    const landingHref =
        process.env.NODE_ENV === "production"
            ? "https://mikeoss.com"
            : "http://localhost:3000";

    const sizeMap = {
        sm: { text: "text-lg", sub: "text-[8px]" },
        md: { text: "text-2xl", sub: "text-[9px]" },
        lg: { text: "text-4xl", sub: "text-xs" },
        xl: { text: "text-6xl", sub: "text-sm" },
    };

    const logo = (
        <div
            className={`flex flex-col gap-0.5 font-sans tracking-tight ${
                animate ? "sidebar-fade-in" : ""
            } ${className}`}
        >
            <span className={`${sizeMap[size].text} leading-none`}>
                <span className="font-light">Mike</span>
                <span className="font-black"> Legal</span>
            </span>
            <span className={`${sizeMap[size].sub} uppercase tracking-[0.14em] text-current opacity-40 font-medium`}>
                AI Platform
            </span>
        </div>
    );

    if (asLink) {
        return (
            <Link
                href={landingHref}
                className="cursor-pointer hover:opacity-75 transition-opacity"
            >
                {logo}
            </Link>
        );
    }

    return logo;
}
