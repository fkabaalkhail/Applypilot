import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import CompanyLogo from "../components/CompanyLogo";
import {
  avatarColor,
  avatarLetter,
  cleanCompanyName,
  isUsableLogoImage,
  logoProviderChain,
} from "../lib/companyLogo";

function setNaturalSize(img: HTMLImageElement, width: number, height: number) {
  Object.defineProperty(img, "naturalWidth", { value: width, configurable: true });
  Object.defineProperty(img, "naturalHeight", { value: height, configurable: true });
}

describe("logoProviderChain", () => {
  it("puts a self-hosted logo first and marks it pre-verified", () => {
    const chain = logoProviderChain({
      company: "Kinaxis",
      company_logo: "/jobs/logo/0123456789abcdef0123456789abcdef01234567.png",
      company_domain: "kinaxis.com",
    });
    expect(chain[0]).toEqual({
      src: "/jobs/logo/0123456789abcdef0123456789abcdef01234567.png",
      verified: true,
    });
    expect(chain[1].src).toBe("https://www.google.com/s2/favicons?domain=kinaxis.com&sz=256");
    expect(chain[1].verified).toBe(false);
    expect(chain).toHaveLength(2);
  });

  it("prefers a stored real CDN logo, then the favicon service, and never unavatar", () => {
    const chain = logoProviderChain({
      company: "Kinaxis",
      company_logo: "https://cdn.jobright.ai/logos/kinaxis.png",
      company_domain: "kinaxis.com",
    });
    expect(chain.map((s) => s.src)).toEqual([
      "https://cdn.jobright.ai/logos/kinaxis.png",
      "https://www.google.com/s2/favicons?domain=kinaxis.com&sz=256",
    ]);
    expect(chain.every((s) => !s.verified)).toBe(true);
    expect(chain.some((s) => s.src.includes("unavatar"))).toBe(false);
  });

  it("skips generated stored logos, including legacy unavatar urls", () => {
    for (const stored of [
      "https://icon.horse/icon/shopify.com",
      "https://unavatar.io/shopify.com?fallback=false",
      "https://www.google.com/s2/favicons?domain=shopify.com&sz=128",
      "https://logos-api.apistemic.com/domain:shopify.com?fallback=404",
    ]) {
      const chain = logoProviderChain({
        company: "Shopify",
        company_logo: stored,
        company_domain: "shopify.com",
      });
      expect(chain.map((s) => s.src)).toEqual([
        "https://www.google.com/s2/favicons?domain=shopify.com&sz=256",
      ]);
    }
  });

  it("never guesses a domain from the company name", () => {
    // "Bell Canada" is not bell.com; without a real domain go straight to the avatar.
    expect(logoProviderChain({ company: "Bell Canada" })).toHaveLength(0);
    expect(logoProviderChain({ company: "" })).toHaveLength(0);
  });

  it("uses a real company website or the curated known-company map when no domain is stored", () => {
    expect(
      logoProviderChain({ company: "Acme", company_url: "https://www.acme-corp.io/careers" })[0].src,
    ).toContain("domain=acme-corp.io");
    expect(logoProviderChain({ company: "**Shopify**" })[0].src).toContain("domain=shopify.com");
  });

  it("drops malformed stored domains instead of requesting them", () => {
    expect(logoProviderChain({ company: "Pure", company_domain: "pure(ycs23).com" })).toHaveLength(0);
    expect(
      logoProviderChain({ company: "Mom's", company_domain: "mom'sorganicmarket.com" }),
    ).toHaveLength(0);
  });
});

describe("isUsableLogoImage", () => {
  it("rejects tiny icons and wide banners, keeps squares and unknown sizes", () => {
    expect(isUsableLogoImage(16, 16)).toBe(false);
    expect(isUsableLogoImage(330, 56)).toBe(false); // wide wordmark strip
    expect(isUsableLogoImage(128, 128)).toBe(true);
    expect(isUsableLogoImage(0, 0)).toBe(true); // SVG without an intrinsic size
  });

  it("rejects large social-share images the way the backend does", () => {
    // Shapes measured on visible prod rows (og:image hotlinks).
    expect(isUsableLogoImage(1200, 630)).toBe(false); // standard 1.91:1 og:image
    expect(isUsableLogoImage(1024, 537)).toBe(false); // Salesforce
    expect(isUsableLogoImage(1280, 720)).toBe(false); // 16:9 stock photo
    expect(isUsableLogoImage(2000, 1000)).toBe(false); // Kinaxis tagline banner
    expect(isUsableLogoImage(2048, 1024)).toBe(false); // Stripe
    expect(isUsableLogoImage(800, 400)).toBe(false);
  });

  it("keeps small wide wordmarks and large square images", () => {
    expect(isUsableLogoImage(300, 160)).toBe(true);
    expect(isUsableLogoImage(330, 204)).toBe(true); // Wikimedia Mastercard, 1.62:1
    expect(isUsableLogoImage(330, 180)).toBe(true); // Wikimedia Eli Lilly, 1.83:1
    expect(isUsableLogoImage(1200, 1200)).toBe(true);
    expect(isUsableLogoImage(2996, 1955)).toBe(true); // 1.53:1 is not a banner
  });
});

describe("letter avatar", () => {
  it("uses the first letter or digit after stripping markdown", () => {
    expect(avatarLetter("**Tesla**")).toBe("T");
    expect(avatarLetter("__boerboel__")).toBe("B");
    expect(avatarLetter("(i3) Integration")).toBe("I");
    expect(avatarLetter("21CS")).toBe("2");
    expect(avatarLetter("École Polytechnique")).toBe("É");
  });

  it("falls back to ? only when the name has no letter or digit", () => {
    expect(avatarLetter("")).toBe("?");
    expect(avatarLetter("   ")).toBe("?");
    expect(avatarLetter("**")).toBe("?");
  });

  it("colors a markdown name the same as its plain spelling", () => {
    expect(avatarColor("**Tesla**")).toBe(avatarColor("Tesla"));
    expect(avatarColor("Tesla")).toBe(avatarColor("Tesla"));
  });

  it("cleans display names", () => {
    expect(cleanCompanyName("**Tesla**")).toBe("Tesla");
    expect(cleanCompanyName("***Wanderlog (W19)***")).toBe("Wanderlog (W19)");
    expect(cleanCompanyName("__Warp__")).toBe("Warp");
    expect(cleanCompanyName("*Nuro*")).toBe("Nuro");
    expect(cleanCompanyName("  Spot & Tango ")).toBe("Spot & Tango");
    expect(cleanCompanyName(null)).toBe("");
  });
});

describe("CompanyLogo", () => {
  it("renders a self-hosted logo as-is, whatever its reported size", () => {
    render(
      <CompanyLogo
        company="Acme"
        company_logo="/jobs/logo/abc.png"
        company_domain="acme.example"
        size={40}
      />,
    );
    const img = screen.getByRole("img") as HTMLImageElement;
    expect(img.getAttribute("src")).toBe("/jobs/logo/abc.png");
    setNaturalSize(img, 16, 16);
    fireEvent.load(img);
    expect(screen.getByRole("img")).toBe(img);
    expect(img.getAttribute("src")).toBe("/jobs/logo/abc.png");
  });

  it("sends no referrer to logo hosts", () => {
    render(<CompanyLogo company="Acme" company_domain="acme.example" />);
    expect(screen.getByRole("img").getAttribute("referrerpolicy")).toBe("no-referrer");
  });

  it("advances to the next provider on error and lands on the letter avatar", () => {
    render(
      <CompanyLogo
        company="**Acme Widgets**"
        company_logo="https://cdn.example.com/acme.png"
        company_domain="acmewidgets.example"
        size={40}
      />,
    );
    let img = screen.getByRole("img");
    fireEvent.error(img); // stored CDN logo 404s -> favicon service
    img = screen.getByRole("img");
    expect(img.getAttribute("src")).toContain("google.com/s2");
    fireEvent.error(img); // favicon service 404s -> letter avatar
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByLabelText("Acme Widgets logo").textContent).toBe("A");
  });

  it("treats a tiny favicon as a miss and shows the letter avatar", () => {
    render(<CompanyLogo company="Acme" company_domain="acme.example" size={40} />);
    const img = screen.getByRole("img") as HTMLImageElement;
    expect(img.src).toContain("google.com/s2");
    setNaturalSize(img, 16, 16);
    fireEvent.load(img);
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByLabelText("Acme logo").textContent).toBe("A");
  });

  it("treats a tiny stored logo as a miss and tries the favicon service", () => {
    render(
      <CompanyLogo
        company="Acme"
        company_logo="https://acme.example/favicon.ico"
        company_domain="acme.example"
      />,
    );
    const img = screen.getByRole("img") as HTMLImageElement;
    setNaturalSize(img, 32, 32);
    fireEvent.load(img);
    expect((screen.getByRole("img") as HTMLImageElement).src).toContain("google.com/s2");
  });

  it("treats a wide stored banner as a miss and tries the favicon service", () => {
    render(
      <CompanyLogo
        company="Parsons"
        company_logo="https://upload.wikimedia.org/parsons-wordmark.png"
        company_domain="parsons.com"
      />,
    );
    const img = screen.getByRole("img") as HTMLImageElement;
    setNaturalSize(img, 330, 35);
    fireEvent.load(img);
    expect((screen.getByRole("img") as HTMLImageElement).src).toContain("domain=parsons.com");
  });

  it("treats a stored 1200x630 og:image as a miss and tries the favicon service", () => {
    render(
      <CompanyLogo
        company="Hitachi"
        company_logo="https://www.hitachi.com/content/dam/hitachi/common/image/og/og_hitachi_logo.png"
        company_domain="hitachi.com"
      />,
    );
    const img = screen.getByRole("img") as HTMLImageElement;
    setNaturalSize(img, 1200, 630);
    fireEvent.load(img);
    expect((screen.getByRole("img") as HTMLImageElement).src).toContain("domain=hitachi.com");
  });

  it("keeps a logo that is large enough and roughly square", () => {
    render(<CompanyLogo company="Acme" company_domain="acme.example" size={40} />);
    const img = screen.getByRole("img") as HTMLImageElement;
    setNaturalSize(img, 48, 48);
    fireEvent.load(img);
    expect(screen.getByRole("img")).toBe(img);
  });

  it("goes straight to the letter avatar when there is no logo and no domain", () => {
    render(<CompanyLogo company="**Boerboel**" />);
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByLabelText("Boerboel logo").textContent).toBe("B");
  });

  it("restarts the chain when the company changes", () => {
    const { rerender } = render(<CompanyLogo company="Acme" company_domain="acme.example" />);
    fireEvent.error(screen.getByRole("img")); // Acme -> letter avatar
    expect(screen.queryByRole("img")).toBeNull();
    rerender(<CompanyLogo company="Kinaxis" company_domain="kinaxis.com" />);
    expect((screen.getByRole("img") as HTMLImageElement).src).toContain("domain=kinaxis.com");
  });
});
