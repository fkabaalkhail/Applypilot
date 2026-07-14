import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { MemoryRouter } from "react-router-dom";

const ping = vi.fn();
vi.mock("../lib/extensionBridge", () => ({ pingExtension: () => ping() }));

import ExtensionBanner from "./ExtensionBanner";
import { CHROME_STORE_URL } from "../lib/extensionStore";

const SNOOZE_KEY = "tailrd.extBanner.snoozedUntil";
const DAY = 24 * 60 * 60 * 1000;

const renderBanner = () =>
  render(
    <MemoryRouter>
      <ExtensionBanner />
    </MemoryRouter>
  );

describe("ExtensionBanner", () => {
  beforeEach(() => {
    ping.mockReset();
    localStorage.clear();
  });

  it("links to the Chrome Web Store when the extension is not installed", async () => {
    ping.mockResolvedValue("not-installed");
    renderBanner();
    const cta = await screen.findByRole("link", { name: /add to chrome/i });
    expect(cta).toHaveAttribute("href", CHROME_STORE_URL);
    expect(cta).toHaveAttribute("target", "_blank");
    expect(cta).toHaveAttribute("rel", expect.stringContaining("noopener"));
  });

  it("points at the connect flow when installed but not signed in", async () => {
    ping.mockResolvedValue("installed");
    renderBanner();
    const cta = await screen.findByRole("link", { name: /finish setup/i });
    expect(cta).toHaveAttribute("href", "/extension/connect");
    expect(screen.queryByRole("link", { name: /add to chrome/i })).toBeNull();
  });

  it("renders nothing once the extension is connected", async () => {
    ping.mockResolvedValue("connected");
    const { container } = renderBanner();
    await waitFor(() => expect(ping).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing while the ping is still pending, so it cannot flash", () => {
    ping.mockReturnValue(new Promise(() => {}));
    const { container } = renderBanner();
    expect(container).toBeEmptyDOMElement();
  });

  it("dismissing hides it and snoozes for 7 days", async () => {
    ping.mockResolvedValue("not-installed");
    renderBanner();
    fireEvent.click(await screen.findByRole("button", { name: /dismiss/i }));
    expect(screen.queryByRole("link", { name: /add to chrome/i })).toBeNull();
    expect(Number(localStorage.getItem(SNOOZE_KEY))).toBeGreaterThan(Date.now() + 6 * DAY);
  });

  it("stays hidden while a snooze is still live", async () => {
    localStorage.setItem(SNOOZE_KEY, String(Date.now() + 3 * DAY));
    ping.mockResolvedValue("not-installed");
    const { container } = renderBanner();
    await waitFor(() => expect(ping).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("clears a stale snooze once connected, so a later uninstall re-prompts", async () => {
    localStorage.setItem(SNOOZE_KEY, String(Date.now() + 3 * DAY));
    ping.mockResolvedValue("connected");
    renderBanner();
    await waitFor(() => expect(localStorage.getItem(SNOOZE_KEY)).toBeNull());
  });
});
