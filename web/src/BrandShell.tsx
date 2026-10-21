import { Outlet, useLocation } from "react-router-dom";

/** Keep the OBS output free of application chrome. */
export default function BrandShell() {
  const { pathname } = useLocation();
  if (pathname === "/viewer" || pathname === "/decart-test") return <Outlet />;
  const creator = ["/router", "/dashboard", "/setup"].includes(pathname);
  return (
    <div className="brand-app">
      <header className="brand-bar">
        <div className="brand-identity" aria-label="Stream Hijack">
          <img src="/brand/icon-180.png" width="52" height="52" alt="" />
          <span>Stream <strong>Hijack</strong></span>
        </div>
        <span className="brand-context">
          {creator ? "CREATOR STUDIO" : "CHAT TAKES OVER"}
        </span>
      </header>
      <Outlet />
    </div>
  );
}
