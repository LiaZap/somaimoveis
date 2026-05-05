"use client";

import { useEffect } from "react";
import { PortalProvider, usePortal } from "@/components/portal/portal-provider";
import { PortalNavbar } from "@/components/portal/portal-navbar";
import { InstallPrompt } from "@/components/portal/install-prompt";
import { BottomNav, type BottomNavItem } from "@/components/layout/bottom-nav";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Building2,
  DollarSign,
  FileText,
  Receipt,
} from "lucide-react";

const portalPrimaryItems: BottomNavItem[] = [
  { label: "Inicio", href: "/portal", icon: LayoutDashboard, exact: true },
  { label: "Imóveis", href: "/portal/imoveis", icon: Building2 },
  { label: "Financeiro", href: "/portal/financeiro", icon: DollarSign },
  { label: "Contratos", href: "/portal/contratos", icon: FileText },
];

const portalMoreItems: BottomNavItem[] = [
  { label: "Extrato", href: "/portal/extrato", icon: Receipt },
  { label: "Demonstrativo", href: "/portal/demonstrativo", icon: Receipt },
  { label: "Fiscal", href: "/portal/fiscal", icon: FileText },
];

function PortalLayoutContent({ children }: { children: React.ReactNode }) {
  const { isLoading, token } = usePortal();
  const pathname = usePathname();
  const isLoginPage = pathname === "/portal/login";

  // Show loading state
  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <p className="text-sm text-muted-foreground">Carregando...</p>
        </div>
      </div>
    );
  }

  // Login page has its own layout (no navbar)
  if (isLoginPage) {
    return <>{children}</>;
  }

  // Authenticated pages get the navbar
  if (!token) {
    return null; // Will redirect via PortalProvider effect
  }

  return (
    <div className="min-h-screen bg-background">
      <PortalNavbar />
      <main className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-6 pb-20 md:pb-6">
        {children}
      </main>
      <BottomNav primaryItems={portalPrimaryItems} moreItems={portalMoreItems} />
      <InstallPrompt />
    </div>
  );
}

function ServiceWorkerRegistration() {
  useEffect(() => {
    if (typeof window !== "undefined" && "serviceWorker" in navigator) {
      // Register the service worker after the page loads
      window.addEventListener("load", () => {
        navigator.serviceWorker
          .register("/sw.js", { scope: "/portal" })
          .then((registration) => {
            console.log(
              "[Somma PWA] Service Worker registered with scope:",
              registration.scope
            );

            // Check for updates periodically (every 60 minutes)
            setInterval(() => {
              registration.update();
            }, 60 * 60 * 1000);
          })
          .catch((error) => {
            console.error(
              "[Somma PWA] Service Worker registration failed:",
              error
            );
          });
      });
    }
  }, []);

  return null;
}

export default function PortalLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <PortalProvider>
      <ServiceWorkerRegistration />
      <PortalLayoutContent>{children}</PortalLayoutContent>
    </PortalProvider>
  );
}
