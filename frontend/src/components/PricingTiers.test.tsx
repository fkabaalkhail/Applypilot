import { test, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import PricingTiers from "./PricingTiers";

test("renders Free and Pro only, Pro at $9.99 CAD, no Lifetime", () => {
  render(<MemoryRouter><PricingTiers /></MemoryRouter>);
  expect(screen.getByRole("heading", { name: "Free" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Pro" })).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "Lifetime" })).toBeNull();
  expect(screen.getByText("$9.99")).toBeInTheDocument();
  expect(screen.getByText(/CAD/)).toBeInTheDocument();
});
