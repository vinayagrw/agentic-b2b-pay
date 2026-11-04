import { AlertTriangle } from "lucide-react";
import { useGet } from "../lib/api";

/** Shown on the login page and the app top bar whenever DEMO_LOGIN=1 on the server. */
export function DemoBanner() {
  const { data } = useGet<{ demo: boolean }>("/auth/config");
  if (!data?.demo) return null;
  return <div role="alert" data-testid="demo-banner" className="flex items-center justify-center gap-2 bg-warn px-4 py-1.5 text-center text-[12px] font-semibold text-black">
    <AlertTriangle size={13} aria-hidden />Demo sign in, not for production
  </div>;
}
