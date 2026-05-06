import Link from "next/link";

export default function NotFound() {
    return (
        <div className="min-h-screen bg-background flex items-center justify-center px-4">
            <div className="text-center max-w-md">
                <h1 className="text-3xl font-sans font-light text-[#292629] mb-3">
                    Page not found
                </h1>
                <p className="text-[0.9375rem] text-[#292629]/50 leading-relaxed mb-8">
                    The page you&apos;re looking for doesn&apos;t exist or may
                    have been moved.
                </p>

                <Link
                    href="/"
                    className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full text-sm font-medium text-[#F5F5F5] bg-[#292629] hover:bg-[#292629]/90 transition-colors"
                >
                    Go home
                </Link>
            </div>
        </div>
    );
}
