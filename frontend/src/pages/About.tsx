import SiteHeader from "../components/site/SiteHeader";
import SiteFooter from "../components/site/SiteFooter";
import "./Landing.css";

export default function About() {
  return (
    <div className="landing">
      <SiteHeader />
      <main className="marketing-page">
        <section className="section" style={{ maxWidth: 760, margin: "0 auto" }}>
          <h1 className="section-title">About Tailrd</h1>
          <p className="section-sub">Apply smarter, not harder.</p>
          <p>
            Tailrd is an AI-powered job-search assistant built for interns and new
            grads. It tailors your résumé to each role, generates cover letters,
            matches you with jobs that fit your real skills, and auto-fills
            applications across the web, so you spend your time preparing for
            interviews instead of retyping the same fields.
          </p>
          <h2 style={{ marginTop: 32 }}>Why we built it</h2>
          <p>
            Early-career job seekers send hundreds of applications, each demanding
            the same tedious data entry and subtle résumé tweaks. We built Tailrd to
            automate the busywork while keeping you in control of every submission.
          </p>
          <h2 style={{ marginTop: 32 }}>Privacy first</h2>
          <p>
            Your résumé and profile are used only to help you apply. We never sell
            your personal information. Read our <a href="/privacy">Privacy Policy</a> and{" "}
            <a href="/cookies">Cookie Policy</a> for details.
          </p>
          <h2 style={{ marginTop: 32 }}>Get in touch</h2>
          <p>
            Questions or feedback? Email us at{" "}
            <a href="mailto:support@tailrd.ca">support@tailrd.ca</a>.
          </p>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
