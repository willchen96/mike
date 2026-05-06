import type { Metadata } from "next";
import { Inter, EB_Garamond } from "next/font/google";
import "./globals.css";
import { Providers } from "@/components/providers";

const inter = Inter({
    variable: "--font-inter",
    subsets: ["latin"],
});

const ebGaramond = EB_Garamond({
    variable: "--font-eb-garamond",
    subsets: ["latin"],
    weight: ["400", "500", "600", "700"],
});

export const metadata: Metadata = {
    title: "Mike - AI Legal Platform",
    description:
        "AI-powered legal document analysis and contract review platform.",
    icons: {
        icon: [
            { url: "/icon.svg", type: "image/svg+xml" },
            { url: "/favicon.ico" },
        ],
        apple: "/apple-touch-icon.png",
    },
};

export default function RootLayout({
    children,
}: Readonly<{
    children: React.ReactNode;
}>) {
    return (
        <html lang="en">
            <body
                className={`${inter.variable} ${ebGaramond.variable} font-sans antialiased`}
            >
                <Providers>{children}</Providers>
                <footer className="fixed bottom-0 left-0 right-0 z-[300] border-t border-gray-200 bg-white/95 px-4 py-2 text-center text-xs text-gray-600 backdrop-blur-sm">
                    <a
                        href="https://mikeoss.com/"
                        target="_blank"
                        rel="noreferrer"
                        className="font-medium text-gray-800 hover:underline"
                    >
                        Mike
                    </a>{" "}
                    is an open source project and The Players Fund has forked
                    it integrate with Scout
                </footer>
            </body>
        </html>
    );
}
