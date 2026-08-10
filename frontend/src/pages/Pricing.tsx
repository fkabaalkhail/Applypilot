import SiteHeader from "../components/site/SiteHeader";
import SiteFooter from "../components/site/SiteFooter";
import PricingTiers from "../components/PricingTiers";
import "./Landing.css";

export default function Pricing() {
  return (
    <div className="landing">
      <SiteHeader />
      <main className="marketing-page">
        <section className="section">
          <h1 className="section-title">Simple Pricing</h1>
          <p className="section-sub">Start free, upgrade when you're ready. Prices in CAD.</p>
          <PricingTiers variant="full" />
          <div className="pricing-faq" style={{ maxWidth: 640, margin: "48px auto 0" }}>
            <h2 className="section-title" style={{ fontSize: "1.5rem" }}>Pricing FAQ</h2>
            <p><strong>Is there a free plan?</strong> Yes. Free includes 10 auto-applies per day, basic job matching, the application tracker, and one resume profile.</p>
            <p><strong>What does Pro cost?</strong> Pro is $9.99 CAD per month and unlocks unlimited auto-applies, AI screening answers, per-job resume tailoring, cover letters, and priority AI processing.</p>
            <p><strong>Can I cancel anytime?</strong> Yes. Pro is month-to-month with no long-term commitment.</p>
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
