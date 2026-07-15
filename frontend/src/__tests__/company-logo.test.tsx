import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import CompanyLogo from "../components/CompanyLogo";
import { logoProviderChain } from "../lib/companyLogo";

describe("logoProviderChain", () => {
  it("prefers a stored real CDN logo, then the 256px favicon service", () => {
    const chain = logoProviderChain({
      company: "Kinaxis",
      company_logo: "https://cdn.jobright.ai/logos/kinaxis.png",
      company_domain: "kinaxis.com",
    });
    expect(chain[0]).toBe("https://cdn.jobright.ai/logos/kinaxis.png");
    expect(chain[1]).toContain("google.com/s2/favicons");
    expect(chain[1]).toContain("sz=256");
    expect(chain).toHaveLength(2);
  });

  it("skips generated logo urls and derives the domain from the name", () => {
    const chain = logoProviderChain({
      company: "Shopify",
      company_logo: "https://icon.horse/icon/shopify.com",
    });
    expect(chain[0]).toContain("google.com/s2/favicons?domain=shopify.com");
  });

  it("returns an empty chain when no domain can be derived", () => {
    expect(logoProviderChain({ company: "" })).toHaveLength(0);
  });
});

describe("CompanyLogo", () => {
  it("advances to the next provider on error and lands on the letter avatar", () => {
    render(
      <CompanyLogo
        company="Acme Widgets"
        company_logo="https://cdn.example.com/acme.png"
        company_domain="acmewidgets.example"
        size={40}
      />,
    );
    let img = screen.getByRole("img");
    fireEvent.error(img); // stored CDN logo 404s
    img = screen.getByRole("img");
    fireEvent.error(img); // favicon service 404s
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByLabelText("Acme Widgets logo").textContent).toBe("A");
  });

  it("treats a tiny favicon as a miss", () => {
    render(<CompanyLogo company="Acme" company_domain="acme.example" size={40} />);
    const img = screen.getByRole("img") as HTMLImageElement;
    expect(img.src).toContain("google.com/s2");
    Object.defineProperty(img, "naturalWidth", { value: 16, configurable: true });
    fireEvent.load(img);
    expect(screen.queryByRole("img")).toBeNull(); // fell through to avatar
  });

  it("keeps a favicon that is large enough to render crisply", () => {
    render(<CompanyLogo company="Acme" company_domain="acme.example" size={40} />);
    const img = screen.getByRole("img") as HTMLImageElement;
    Object.defineProperty(img, "naturalWidth", { value: 48, configurable: true });
    fireEvent.load(img);
    expect(screen.getByRole("img")).toBe(img);
  });
});
