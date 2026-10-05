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
          <p className="section-sub">You stay the author.</p>
          <p>
            Tailrd is a job-search assistant built for interns and new grads. It
            matches you with jobs that fit your real skills, fills the repetitive
            fields of an application from your profile, and uses AI to suggest
            résumé edits and talking points for screening questions and cover
            letters. You review, edit, and own every word, so you spend your time
            on the parts of an application that need you.
          </p>
          <h2 style={{ marginTop: 32 }}>Why we built it</h2>
          <p>
            Early-career job seekers send hundreds of applications, each demanding
            the same tedious data entry and subtle résumé tweaks. We built Tailrd to
            take care of the busywork while keeping you in control of every submission.
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
