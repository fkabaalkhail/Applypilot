import { useNavigate } from "react-router-dom";

interface Tier {
  name: string;
  price: string;
  cadence: string;
  features: string[];
  cta: string;
  featured: boolean;
  badge?: string;
}

const TIERS: Tier[] = [
  {
    name: "Free",
    price: "$0",
    cadence: "/month",
    features: ["10 auto-applies per day", "Basic job matching", "Application tracker", "1 resume profile"],
    cta: "Get started",
    featured: false,
  },
  {
    name: "Pro",
    price: "$9.99",
    cadence: "CAD / month",
    features: [
      "Unlimited auto-applies",
      "AI screening answers",
      "Resume tailoring per job",
      "Cover letter generation",
      "Priority AI processing",
      "Advanced match scoring",
    ],
    cta: "Get started",
    featured: true,
    badge: "Most Popular",
  },
];

/** Free + Pro pricing cards. Single source of truth for the home teaser and the
 *  /pricing page. Display-only — CTAs route to sign-up (billing is not wired). */
export default function PricingTiers({ variant = "full" }: { variant?: "teaser" | "full" }) {
  const navigate = useNavigate();
  return (
    <div className={`pricing-grid pricing-grid-${variant}`}>
      {TIERS.map((tier) => (
        <div key={tier.name} className={`pricing-card${tier.featured ? " pricing-featured" : ""}`}>
          {tier.badge && <div className="pricing-badge">{tier.badge}</div>}
          <h3>{tier.name}</h3>
          <div className="pricing-price">{tier.price}<span>{tier.cadence}</span></div>
          <ul className="pricing-features">
            {tier.features.map((f) => <li key={f}>✓ {f}</li>)}
          </ul>
          {/* Billing is not wired yet — CTA routes to sign-up (display-only pricing). */}
          <button
            className={`${tier.featured ? "btn-cta btn-lg" : "btn-outline-lg"} w-full`}
            onClick={() => navigate("/sign-up")}
          >
            {tier.cta}
          </button>
        </div>
      ))}
    </div>
  );
}
