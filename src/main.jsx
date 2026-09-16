import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import Admin from "./Admin";
import "./styles.css";

const isAdmin = window.location.pathname === "/admin";
const level = new URLSearchParams(window.location.search).get("level") || "3";

function ScheduleRoot() {
  return <><nav className="level-nav"><a href="/admin">Admin</a>{[1, 2, 3, 4, 5].map((item) => <a key={item} className={String(item) === level ? "active" : ""} href={`/?level=${item}`}>Level {item}</a>)}</nav><App key={level} /></>;
}

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    {isAdmin ? <Admin /> : <ScheduleRoot />}
  </React.StrictMode>
);
