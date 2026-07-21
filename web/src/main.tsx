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

const router = createBrowserRouter([
  { path: "/", element: <Navigate to="/portal" replace /> },
  { path: "/portal", element: <PortalPage /> },
  { path: "/router", element: <RouterPage /> },
  { path: "/viewer", element: <ViewerPage /> },
  { path: "/decart-test", element: <DecartTestPage /> },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
