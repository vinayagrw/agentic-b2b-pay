import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
export const cn = (...v: ClassValue[]) => twMerge(clsx(v));
export const usd = (n: number) => `$${(n ?? 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const short = (s: string | null | undefined, n = 10) => (s ? (s.length > n * 2 ? `${s.slice(0, n)}...${s.slice(-4)}` : s) : "");
