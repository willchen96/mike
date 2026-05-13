import type { Metadata } from "next";
import { Inter, EB_Garamond } from "next/font/google";
import "./globals.css";
import { Providers } from "@/components/providers";
import { NextIntlClientProvider } from "next-intl";
import { getMessages } from "next-intl/server";

const inter = Inter({
    variable: "--font-inter",
    subsets: ["latin"],
});

const ebGaramond = EB_Garamond({
    variable: "--font-eb-garamond",
    subsets: ["latin"],
    weight: ["400", "500", "600", "700"],
});

const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME ?? "Sistema";
const APP_TITLE = process.env.NEXT_PUBLIC_APP_TITLE ?? `${APP_NAME} - Plataforma Jurídica com IA`;
const APP_DESCRIPTION = process.env.NEXT_PUBLIC_APP_DESCRIPTION ?? "Análise de documentos jurídicos e revisão de contratos com inteligência artificial.";
const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

export const metadata: Metadata = {
    metadataBase: new URL(APP_URL),
    title: APP_TITLE,
    description: APP_DESCRIPTION,
    icons: {
        icon: [
            { url: "/icon.svg", type: "image/svg+xml" },
            { url: "/favicon.ico" },
        ],
        apple: "/apple-touch-icon.png",
    },
    openGraph: {
        type: "website",
        url: APP_URL,
        siteName: APP_NAME,
        title: APP_TITLE,
        description: APP_DESCRIPTION,
        images: [
            {
                url: "/link-image.jpg",
                width: 1200,
                height: 651,
                alt: APP_NAME,
            },
        ],
    },
    twitter: {
        card: "summary_large_image",
        title: APP_TITLE,
        description: APP_DESCRIPTION,
        images: ["/link-image.jpg"],
    },
};

export default async function RootLayout({
    children,
}: Readonly<{
    children: React.ReactNode;
}>) {
    const messages = await getMessages();
    return (
        <html lang="pt-BR">
            <body
                className={`${inter.variable} ${ebGaramond.variable} font-sans antialiased`}
            >
                <NextIntlClientProvider messages={messages}>
                    <Providers>{children}</Providers>
                </NextIntlClientProvider>
            </body>
        </html>
    );
}
