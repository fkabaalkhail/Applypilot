import { test, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import SiteFooter from "./SiteFooter";

test("footer links resolve to real routes; no dead/removed links", () => {
  render(<MemoryRouter><SiteFooter /></MemoryRouter>);
  expect(screen.getByRole("link", { name: "About" })).toHaveAttribute("href", "/about");
  expect(screen.getByRole("link", { name: "Terms of Service" })).toHaveAttribute("href", "/terms");
  expect(screen.getByRole("link", { name: "Cookie Policy" })).toHaveAttribute("href", "/cookies");
  expect(screen.getByRole("link", { name: "Pricing" })).toHaveAttribute("href", "/pricing");
  expect(screen.getByRole("link", { name: "Privacy Policy" })).toHaveAttribute("href", "/privacy");
  expect(screen.queryByRole("link", { name: "Blog" })).toBeNull();
  expect(screen.queryByRole("link", { name: "Careers" })).toBeNull();
  document.querySelectorAll("a").forEach((a) =>
    expect(a.getAttribute("href")).not.toBe("#"));
});
