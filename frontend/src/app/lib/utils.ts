import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
}

/**
 * Calculates the Dice Coefficient between two strings.
 * Returns a value between 0 and 1, where 1 is an exact match.
 */
export function diceCoefficient(str1: string, str2: string): number {
    if (!str1 || !str2) return 0;

    const s1 = str1.toLowerCase().replace(/[^a-z0-9]/g, "");
    const s2 = str2.toLowerCase().replace(/[^a-z0-9]/g, "");

    if (s1 === s2) return 1;
    if (s1.length < 2 || s2.length < 2) return 0;

    const bigrams1 = new Map<string, number>();
    for (let i = 0; i < s1.length - 1; i++) {
        const bigram = s1.substring(i, i + 2);
        bigrams1.set(bigram, (bigrams1.get(bigram) || 0) + 1);
    }

    let intersection = 0;
    for (let i = 0; i < s2.length - 1; i++) {
        const bigram = s2.substring(i, i + 2);
        const count = bigrams1.get(bigram);
        if (count && count > 0) {
            intersection++;
            bigrams1.set(bigram, count - 1);
        }
    }

    return (2 * intersection) / (s1.length - 1 + s2.length - 1);
}

/**
 * Checks if two strings are a fuzzy match based on a threshold.
 * Default threshold is 0.7.
 */
export function isFuzzyMatch(
    str1: string,
    str2: string,
    threshold = 0.7
): boolean {
    return diceCoefficient(str1, str2) >= threshold;
}
