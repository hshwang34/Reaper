import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import {
  createBrowserRouter,
  Navigate,
  RouterProvider,
} from "react-router-dom";
import "./index.css";
import PortalPage from "./portal/PortalPage.js";
import RouterPage from "./router/RouterPage.js";
import ViewerPage from "./viewer/ViewerPage.js";
import DecartTestPage from "./decarttest/DecartTestPage.js";
import SetupPage from "./setup/SetupPage.js";
import DashboardPage from "./dashboard/DashboardPage.js";

const router = createBrowserRouter([
  { path: "/", element: <Navigate to="/portal" replace /> },
  { path: "/portal", element: <PortalPage /> },
  // Hosted portal: the control plane serves the same SPA at /c/<channel>
  // (login or id); channel scoping happens in lib/channel.ts, not the page.
  { path: "/c/:channel", element: <PortalPage /> },
  // Desktop-only onboarding wizard (needs window.rhDesktop).
  { path: "/setup", element: <SetupPage /> },
  // Hosted streamer dashboard (settings + tips connect + ledger).
  { path: "/dashboard", element: <DashboardPage /> },
  { path: "/router", element: <RouterPage /> },
  { path: "/viewer", element: <ViewerPage /> },
  { path: "/decart-test", element: <DecartTestPage /> },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
