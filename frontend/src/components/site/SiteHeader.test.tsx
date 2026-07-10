import { test, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "../../auth/AuthProvider";
import SiteHeader from "./SiteHeader";

test("nav: Pricing is a page link, sections are hash links", () => {
  render(
    <AuthProvider>
      <MemoryRouter>
        <SiteHeader />
      </MemoryRouter>
    </AuthProvider>
  );
  expect(screen.getByRole("link", { name: "Pricing" })).toHaveAttribute("href", "/pricing");
  expect(screen.getByRole("link", { name: "Features" })).toHaveAttribute("href", "/#features");
});
