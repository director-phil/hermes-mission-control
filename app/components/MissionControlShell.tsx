"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import EnvironmentBanner from "./EnvironmentBanner";
import {
  getMissionControlRoute,
  missionControlRoutes,
  missionControlShellTokens,
} from "../mission-control/navigation";

export default function MissionControlShell({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);
  const firstDrawerLinkRef = useRef<HTMLAnchorElement | null>(null);

  const activeRoute = useMemo(() => {
    const segment = pathname.replace(/^\/mission-control\/?/, "").split("/")[0] ?? "";
    return getMissionControlRoute(segment) ?? missionControlRoutes[0];
  }, [pathname]);

  useEffect(() => {
    if (!drawerOpen) return;
    firstDrawerLinkRef.current?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setDrawerOpen(false);
        menuButtonRef.current?.focus();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [drawerOpen]);

  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);

  return (
    <div
      className="mc-shell min-h-screen overflow-x-hidden bg-[var(--mc-canvas)] text-slate-100"
      style={
        {
          "--mc-rail-width": missionControlShellTokens.desktopRailWidth,
          "--mc-canvas": missionControlShellTokens.canvas,
          "--mc-accent": missionControlShellTokens.activeAccent,
        } as React.CSSProperties
      }
    >
      <a className="mc-skip-link" href="#mission-control-main">
        Skip to main content
      </a>

      <aside className="mc-desktop-rail" aria-label="Mission Control navigation rail">
        <div className="mc-brand">
          <span className="mc-brand-mark" aria-hidden="true" />
          <div>
            <p className="mc-kicker">Hermes</p>
            <p className="mc-brand-title">Mission Control</p>
          </div>
        </div>
        <MissionControlNav activeHref={activeRoute.href} />
      </aside>

      <div className="mc-app-column">
        <header className="mc-status-header">
          <div className="mc-mobile-bar">
            <button
              ref={menuButtonRef}
              type="button"
              className="mc-menu-button"
              aria-controls="mission-control-drawer"
              aria-expanded={drawerOpen}
              onClick={() => setDrawerOpen((open) => !open)}
            >
              <span className="sr-only">Open Mission Control navigation</span>
              <span aria-hidden="true" />
              <span aria-hidden="true" />
              <span aria-hidden="true" />
            </button>
            <div>
              <p className="mc-kicker">Hermes</p>
              <p className="mc-mobile-title">Mission Control</p>
            </div>
          </div>
          <EnvironmentBanner />
        </header>

        <main
          id="mission-control-main"
          className="mc-main"
          tabIndex={-1}
          aria-labelledby="mission-control-title"
        >
          <div className="mc-page-heading">
            <div>
              <p className="mc-kicker">Reference shell</p>
              <h1 id="mission-control-title">{activeRoute.label}</h1>
            </div>
            <p>{activeRoute.description}</p>
          </div>
          {children}
        </main>
      </div>

      <div
        className={`mc-drawer-backdrop ${drawerOpen ? "is-open" : ""}`}
        hidden={!drawerOpen}
        onClick={() => setDrawerOpen(false)}
      />
      <div
        id="mission-control-drawer"
        className={`mc-mobile-drawer ${drawerOpen ? "is-open" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label="Mission Control navigation"
        hidden={!drawerOpen}
      >
        <div className="mc-drawer-header">
          <div>
            <p className="mc-kicker">Navigation</p>
            <p className="mc-mobile-title">Mission Control</p>
          </div>
          <button
            type="button"
            className="mc-close-button"
            onClick={() => {
              setDrawerOpen(false);
              menuButtonRef.current?.focus();
            }}
          >
            <span className="sr-only">Close navigation</span>
            <span aria-hidden="true">x</span>
          </button>
        </div>
        <MissionControlNav
          activeHref={activeRoute.href}
          firstLinkRef={firstDrawerLinkRef}
        />
      </div>
    </div>
  );
}

function MissionControlNav({
  activeHref,
  firstLinkRef,
}: {
  activeHref: string;
  firstLinkRef?: React.RefObject<HTMLAnchorElement | null>;
}) {
  return (
    <nav className="mc-nav" aria-label="Mission Control">
      {missionControlRoutes.map((route, index) => {
        const active = route.href === activeHref;
        return (
          <Link
            key={route.href}
            ref={index === 0 ? firstLinkRef : undefined}
            href={route.href}
            className="mc-nav-link"
            aria-current={active ? "page" : undefined}
          >
            <span className="mc-nav-dot" aria-hidden="true" />
            <span>{route.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
